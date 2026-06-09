// Task-bank DB layer (PostgreSQL) for the active-learning task picker.
//
//   tasks      — read-mostly, seeded from the bank JSON artifact (seedTasks).
//   responses  — append-only participant answers (recordResponse).
//
// The Beta prevalence posterior + AI-exposure live in SQL views (schema.postgres.sql),
// so this module just reads/writes rows; acquire() blends the posterior with the LLM
// relevance gate. Mirrors scripts/new_tasks/draw_from_bank.py + evidence.py.
//
// Requires:  npm install pg   ·   env: DATABASE_URL   ·   ESM (matches server.js)
import pg from 'pg';
import fs from 'fs';
import OpenAI from 'openai';
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const REL_W = { high: 1.0, medium: 0.6, low: 0.3 };   // relevance multiplier (the gate)
const PRIOR_VAR = 1 / 12;                              // flat-prior variance (max ignorance)
const EMBED_MODEL = 'text-embedding-3-small';
const HARVEST_MATCH_SIM = Number(process.env.TASK_BANK_HARVEST_SIM || 0.6);  // cosine to merge a generated task
const ANNEAL_PARTICIPANTS = Number(process.env.ANNEAL_PARTICIPANTS || 20);
const RESOLVE_VAR = Number(process.env.TASK_BANK_RESOLVE_VAR || 0.02);   // a task below this is "resolved"
const DESCRIBE_FLOOR = Number(process.env.TASK_BANK_DESCRIBE_FLOOR ?? 0.2); // always reserve this much describe

// ── seed (factory artifact → tasks) ──────────────────────────────────────────
// Re-runnable: clears this occupation's rows, inserts fresh. Never touches responses.
async function seedTasks(bankJsonPath) {
  const bank = JSON.parse(fs.readFileSync(bankJsonPath, 'utf8'));
  const occ = bank.occupation;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM tasks WHERE occupation = $1', [occ]);
    for (const t of bank.tasks) {
      await client.query(
        `INSERT INTO tasks (id, occupation, statement, source, level, ai, weight, status, cluster_id, corroborated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [t.id, occ, t.statement, t.source, t.level ?? null, !!t.ai, t.weight ?? 1,
         t.source === 'single_participant' ? 'active' : 'proposed',
         t.cluster_id ?? null, JSON.stringify(t.corroborated_by ?? [])]);
    }
    await client.query('COMMIT');
    return bank.tasks.length;
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

// ── reads ────────────────────────────────────────────────────────────────────
// Bank tasks + current prevalence posterior + exposure for one occupation.
async function loadBank(occupation) {
  const { rows } = await pool.query(
    `SELECT t.id, t.statement, t.source, t.level, t.ai, t.weight,
            p.n_shown, p.n_confirmed, p.mean, p.variance,
            e.n AS exp_n, e.variance AS exp_var
       FROM tasks t
       JOIN task_posterior p ON p.id = t.id
       LEFT JOIN task_exposure e ON e.task = t.id
      WHERE t.occupation = $1 AND t.status <> 'retired'`,
    [occupation]);
  return rows;
}

async function nParticipants(occupation) {
  const { rows } = await pool.query(
    `SELECT count(DISTINCT r.participant)::int AS n
       FROM responses r JOIN tasks t ON t.id = r.task
      WHERE t.occupation = $1`, [occupation]);
  return rows[0].n;
}

async function lambdaFor(occupation) {
  const seen = await nParticipants(occupation);
  return ANNEAL_PARTICIPANTS ? Math.min(1, seen / ANNEAL_PARTICIPANTS) : 0;
}

// ── online harvest (the loop grows the bank) ─────────────────────────────────
// A generated task the participant answered is NOT in the bank. Embed it, find the
// nearest existing task for the occupation; if cosine >= HARVEST_MATCH_SIM it's the SAME
// task (pool the response with it), else INSERT it as a new 'emergent' bank task. Either
// way record the response. This dedups paraphrases across participants live (pgvector NN),
// so the bank grows from cold start and the posterior accumulates against shared task ids.
async function embedText(text) {
  const r = await openai.embeddings.create({ model: EMBED_MODEL, input: text });
  return r.data[0].embedding;
}
const vlit = v => `[${v.join(',')}]`;                  // pgvector literal

async function harvestResponse({ participant, occupation, statement, response,
                                 aiExposure = null, eligible = true }) {
  if (!occupation || !statement) throw new Error('harvest needs occupation + statement');
  const emb = await embedText(statement);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // nearest existing task for this occupation (cosine sim = 1 − distance)
    const nn = await client.query(
      `SELECT id, 1 - (embedding <=> $2::vector) AS sim
         FROM tasks WHERE occupation = $1 AND embedding IS NOT NULL
         ORDER BY embedding <=> $2::vector LIMIT 1`,
      [occupation, vlit(emb)]);
    let taskId, matched = false, sim = nn.rows[0]?.sim ?? null;
    if (nn.rows[0] && Number(nn.rows[0].sim) >= HARVEST_MATCH_SIM) {
      taskId = nn.rows[0].id; matched = true;          // pool with the existing task
    } else {
      taskId = 'E' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
      await client.query(
        `INSERT INTO tasks (id, occupation, statement, source, weight, status, embedding)
         VALUES ($1,$2,$3,'emergent',1,'active',$4::vector)`,
        [taskId, occupation, statement, vlit(emb)]);    // new emergent bank task at cold prior
    }
    await client.query(
      `INSERT INTO responses (participant, task, occupation, eligible, response, ai_exposure)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [participant, taskId, occupation, eligible, response, aiExposure]);
    await client.query('COMMIT');
    return { taskId, matched, sim: sim == null ? null : Number(sim) };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

// ── write-back (the loop) ────────────────────────────────────────────────────
async function recordResponse({ participant, task, occupation = null,
                                eligible = true, response, aiExposure = null }) {
  if (response !== 'confirm' && response !== 'deny')
    throw new Error(`response must be confirm|deny, got ${response}`);
  await pool.query(
    `INSERT INTO responses (participant, task, occupation, eligible, response, ai_exposure)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [participant, task, occupation, eligible, response, aiExposure]);
}

// ── acquisition: acquire = REL_W[tier] · [ λ·mean + (1−λ)·max(prevVar, exposureUnc) ] ──
function exposureUncertainty(expN, expVar) {
  if (!expN) return PRIOR_VAR;                // unrated → maximal
  if (expN === 1) return PRIOR_VAR / 2;       // one rating → still uncertain
  return (Number(expVar) || 0) / expN;        // standard error² of the mean
}

// DUAL goal (describe + learn), CORE + TAIL. Reserve `describeFrac` of the budget for
// DESCRIPTION — the relevance-eligible tasks the worker most likely DOES (highest
// relevance·prevalence-mean) — and the rest for LEARNING — pure uncertainty sampling
// (highest relevance·prevalence-variance). The two goals get SEPARATE slots.
// Why not one blended score: simulate_active_learning.py showed λ·mean + (1−λ)·var collapses
// learning below random even at λ=0.3 (exploit-on-mean pollutes the whole ranking), whereas
// core+tail still beats random up to ~40% describe and degrades gracefully.
// selected: [{ id, relevance }] from the LLM gate.  bankRows: from loadBank().
// describeFrac: null = ADAPTIVE (default) — learn slots = the still-uncertain eligible tasks,
// capped, with a describe floor, so it auto-anneals to description as the bank resolves and
// never re-samples a resolved task. A number = a fixed describe fraction.
function acquire(bankRows, selected, budget = 25, describeFrac = null, priorTasks = []) {
  const byId = new Map(bankRows.map(r => [r.id, r]));
  const prior = new Set((priorTasks || []).map(s => String(s).trim().toLowerCase()));
  const rel = r => REL_W[r.relevance] ?? 0.3;
  const elig = selected
    .map(s => { const r = byId.get(s.id); return r && { ...r, relevance: s.relevance }; })
    .filter(r => r && !prior.has(r.statement.trim().toLowerCase()));

  const k = budget > 0 ? Math.min(budget, elig.length) : elig.length;
  let nDesc;
  if (describeFrac == null) {                                  // ADAPTIVE
    const uncertain = elig.filter(r => Number(r.variance) > RESOLVE_VAR).length;
    const learnCap = k - Math.round(DESCRIBE_FLOOR * k);
    nDesc = k - Math.min(uncertain, learnCap);
  } else {
    nDesc = Math.round(describeFrac * k);
  }
  const core = [...elig].sort((a, b) => rel(b) * Number(b.mean) - rel(a) * Number(a.mean))
                        .slice(0, nDesc);
  const coreIds = new Set(core.map(r => r.id));
  const tail = elig.filter(r => !coreIds.has(r.id))
                   .sort((a, b) => rel(b) * Number(b.variance) - rel(a) * Number(a.variance))
                   .slice(0, k - nDesc);

  // Interleave describe + learn so the uncertain (learn) tasks aren't all at the end —
  // they'd hit response fatigue and form a skippable block, biasing exactly the answers
  // we most need. Spreads them through the list instead.
  core.forEach(r => { r.slot = 'describe'; });
  tail.forEach(r => { r.slot = 'learn'; });
  const out = [];
  for (let i = 0; i < Math.max(core.length, tail.length); i++) {
    if (i < core.length) out.push(core[i]);
    if (i < tail.length) out.push(tail[i]);
  }
  return out.map(r => ({ id: r.id, statement: r.statement, level: r.level, ai: r.ai,
                         relevance: r.relevance, slot: r.slot }));
}

export { pool, seedTasks, loadBank, nParticipants, lambdaFor, recordResponse, acquire, REL_W };
