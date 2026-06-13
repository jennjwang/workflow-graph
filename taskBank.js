// Task-bank DB layer (PostgreSQL) for the active-learning task picker.
//
//   tasks      — read-mostly, seeded from the bank JSON artifact (seedTasks).
//   responses  — append-only participant answers (recordResponse).
//
// The Beta prevalence posterior + AI-exposure live in SQL views (schema.postgres.sql), so this
// module just reads/writes rows; acquire() selects representative PROBES (decidability-ordered) over
// the UNDECIDED tasks. The decision logic here is a port of final/active_learning/evidence.py —
// keep the two in sync.
//
// Requires:  npm install pg   ·   env: DATABASE_URL   ·   ESM (matches server.js)
import pg from 'pg';
import fs from 'fs';
import OpenAI from 'openai';
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const EMBED_MODEL = 'text-embedding-3-small';
// harvest cosine BANDS (calibrate on real pairs): ≥HIGH auto-pool a near-dup, ≤LOW auto-insert,
// in-between → LLM equivalence-confirm. Conservative HIGH avoids the cosine over-merge this project saw.
const HARVEST_SIM_HIGH = Number(process.env.TASK_BANK_HARVEST_HIGH ?? 0.93);
const HARVEST_SIM_LOW  = Number(process.env.TASK_BANK_HARVEST_LOW  ?? 0.55);
const HARVEST_TOPK     = Number(process.env.TASK_BANK_HARVEST_TOPK ?? 5);    // NN candidates shown to the LLM

// ── inventory decision (PORT of final/active_learning/evidence.py — keep the two in sync) ──
// θ = O*NET Core bar · c = decision confidence · δ = indifference half-margin → BOUNDARY.
const THETA = Number(process.env.TASK_BANK_THETA ?? 0.67);
const C     = Number(process.env.TASK_BANK_C     ?? 0.95);
const DELTA = Number(process.env.TASK_BANK_DELTA ?? 0.12);
const PROBE_MAX = Number(process.env.TASK_BANK_PROBE_MAX ?? 12);  // fatigue ceiling: max probes / session
const PROBE_MIN = Number(process.env.TASK_BANK_PROBE_MIN ?? 2);   // floor while ANY task is still undecided
// Thompson-style randomization of the decidability order (softmax/Gumbel temperature). Concurrent
// participants read the same posterior, so a DETERMINISTIC top-k herds them onto identical probes;
// τ>0 spreads the picks. Sim-validated: τ≈0.1 ties deterministic when sequential and ~4× better under
// heavy concurrency. 0 = deterministic.
const PROBE_TAU = Number(process.env.TASK_BANK_PROBE_TAU ?? 0.1);

// ── seed (factory artifact → tasks) ──────────────────────────────────────────
// Re-runnable: clears this occupation's rows, inserts fresh. Never touches responses.
async function seedTasks(bankJsonPath) {
  const bank = JSON.parse(fs.readFileSync(bankJsonPath, 'utf8'));
  const occ = bank.occupation;
  // embed every statement up front so the harvest NN prefilter works from the first interview
  const embs = bank.tasks.length ? await embedMany(bank.tasks.map(t => t.statement)) : [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM tasks WHERE occupation = $1', [occ]);
    for (let i = 0; i < bank.tasks.length; i++) {
      const t = bank.tasks[i];
      await client.query(
        `INSERT INTO tasks (id, occupation, statement, source, level, ai, weight, status, cluster_id, corroborated_by, embedding)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::vector)`,
        [t.id, occ, t.statement, t.source, t.level ?? null, !!t.ai, t.weight ?? 1,
         t.source === 'single_participant' ? 'active' : 'proposed',
         t.cluster_id ?? null, JSON.stringify(t.corroborated_by ?? []), vlit(embs[i])]);
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

// ── per-interview MERGE / async harvest (the loop grows the bank) ─────────────
// After a session, drainSession() folds that participant's CONFIRMED generated tasks into the bank:
// embed → pgvector NN PREFILTER → cosine BANDS (auto-pool a near-dup / auto-insert if nothing close /
// LLM equivalence-confirm in the gray zone) → pool onto an existing task (bump its weight, existence
// corroboration) or INSERT a new cold 'emergent' candidate. It NEVER writes `responses`, so these
// relevance-gated confirmations grow recall but do NOT move the representative DECISION. Serialized
// cluster-wide by a per-occupation pg advisory lock so two simultaneous drains can't double-insert the
// same new task (the 2nd blocks, then finds the 1st's insert via NN and pools).
async function embedText(text) {
  const r = await openai.embeddings.create({ model: EMBED_MODEL, input: text });
  return r.data[0].embedding;
}
async function embedMany(texts) {                      // batched (chunked) so we embed OUTSIDE the lock
  const out = [];
  for (let i = 0; i < texts.length; i += 256) {
    const r = await openai.embeddings.create({ model: EMBED_MODEL, input: texts.slice(i, i + 256) });
    out.push(...r.data.map(d => d.embedding));
  }
  return out;
}
const vlit = v => `[${v.join(',')}]`;                  // pgvector literal

// gray-zone arbiter: is `statement` the SAME task as any candidate? → matched id, else null (new).
async function llmEquivalent(statement, candidates) {
  const list = candidates.map((c, i) => `${i + 1}. ${c.statement}`).join('\n');
  const r = await openai.chat.completions.create({
    model: 'gpt-4o-mini', temperature: 0, max_tokens: 20,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content:
        'Decide whether a NEW software-work task is the SAME task as any CANDIDATE (same activity and '
        + 'scope, ignoring wording) or genuinely NEW. SAME only if doing one necessarily means doing the '
        + 'other; a different scope, sub-step, or broader/narrower activity is NEW. '
        + 'Reply JSON {"match": <candidate number or null>}.' },
      { role: 'user', content: `NEW: ${statement}\n\nCANDIDATES:\n${list}` },
    ],
  });
  const m = JSON.parse(r.choices[0].message.content).match;
  return (Number.isInteger(m) && m >= 1 && m <= candidates.length) ? candidates[m - 1].id : null;
}

// match-or-insert ONE statement (embedding precomputed). Must run under the advisory lock.
async function harvestOne(client, occupation, statement, emb) {
  const nn = await client.query(
    `SELECT id, statement, 1 - (embedding <=> $2::vector) AS sim
       FROM tasks WHERE occupation = $1 AND embedding IS NOT NULL
       ORDER BY embedding <=> $2::vector LIMIT $3`,
    [occupation, vlit(emb), HARVEST_TOPK]);
  const top = nn.rows[0];
  let matchId = null, action;
  if (top && Number(top.sim) >= HARVEST_SIM_HIGH) { matchId = top.id; action = 'pool-auto'; }
  else if (!top || Number(top.sim) <= HARVEST_SIM_LOW) { action = 'insert-auto'; }
  else { matchId = await llmEquivalent(statement, nn.rows); action = matchId ? 'pool-llm' : 'insert-llm'; }

  if (matchId) {                                       // pool: +1 existence corroboration (weight)
    await client.query('UPDATE tasks SET weight = weight + 1 WHERE id = $1', [matchId]);
    return { taskId: matchId, matched: true, action };
  }
  const taskId = 'E' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  await client.query(                                  // insert: new cold candidate (UNDECIDED, weight 1)
    `INSERT INTO tasks (id, occupation, statement, source, weight, status, embedding)
     VALUES ($1,$2,$3,'emergent',1,'active',$4::vector)`,
    [taskId, occupation, statement, vlit(emb)]);
  return { taskId, matched: false, action };
}

async function drainSession({ participant, occupation }) {
  if (!occupation || !participant) throw new Error('drainSession needs participant + occupation');
  // read pending on a short-lived pooled connection (released immediately)
  const { rows: pend } = await pool.query(
    `SELECT id, statement FROM generated_responses
      WHERE occupation = $1 AND participant = $2 AND harvested_at IS NULL AND response = 'confirm'
      ORDER BY id`, [occupation, participant]);
  // batch-embed with NO connection held and NO lock — the slow part is fully concurrent across drains
  const embs = pend.length ? await embedMany(pend.map(r => r.statement)) : [];

  // only now take a connection + the advisory lock, for the short serialized write phase
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [occupation]);   // serialize bank writes
    let inserted = 0, pooled = 0;
    try {
      for (let i = 0; i < pend.length; i++) {
        const res = await harvestOne(client, occupation, pend[i].statement, embs[i]);
        await client.query('UPDATE generated_responses SET harvested_at = now(), harvested_task = $2 WHERE id = $1',
          [pend[i].id, res.taskId]);
        res.matched ? pooled++ : inserted++;
      }
      await client.query(                              // DENIES: mark processed, no bank action
        `UPDATE generated_responses SET harvested_at = now()
          WHERE occupation = $1 AND participant = $2 AND harvested_at IS NULL`, [occupation, participant]);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [occupation]).catch(() => {});
    }
    return { merged: pend.length, inserted, pooled };
  } finally { client.release(); }
}

// ── write-back (the loop) ────────────────────────────────────────────────────
async function recordResponse({ participant, task, occupation = null, isProbe = true,
                                shownStatement = null, response, aiExposure = null }) {
  if (response !== 'confirm' && response !== 'deny')
    throw new Error(`response must be confirm|deny, got ${response}`);
  await pool.query(
    `INSERT INTO responses (participant, task, occupation, is_probe, shown_statement, response, ai_exposure)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [participant, task, occupation, isProbe, shownStatement, response, aiExposure]);
}

// ── staging (online harvest is OFF): park a confirmed/denied GENERATED (non-bank) task for
//    periodic OFFLINE clustering into the bank. No view/decision reads generated_responses. ──
async function stageGeneratedResponse({ participant, occupation = null, statement,
                                        source = null, response, relevance = null, aiExposure = null }) {
  if (response !== 'confirm' && response !== 'deny')
    throw new Error(`response must be confirm|deny, got ${response}`);
  if (!statement) throw new Error('stageGeneratedResponse needs a statement');
  await pool.query(
    `INSERT INTO generated_responses (participant, occupation, statement, source, response, relevance, ai_exposure)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [participant, occupation, statement, source, response, relevance, aiExposure]);
}

// ── serving: representative PROBE tasks from the bank (decidability-ordered, UNFILTERED) ──
// ADAPTIVE per-session budget (no fixed count): the bank grows only between sessions (via harvest),
// so the per-session signal is how much of it is still unresolved. Spend more of the fatigue ceiling
// while lots is undecided (probe hard to resolve the inventory), and cede slots to generation as it
// firms up — bounded by PROBE_MAX (fatigue) and by how many tasks are actually still UNDECIDED, with
// a PROBE_MIN trickle while any work remains. So probes/session = a demand-driven hump, not a constant.
async function pickProbes(occupation) {
  const rows = await loadBank(occupation);
  const pool = acquire(rows);                                        // ALL undecided, most-decidable first
  if (!pool.length) return [];                                       // inventory resolved → no probes owed
  const undecidedFrac = pool.length / Math.max(1, rows.length);
  const budget = Math.min(pool.length,
                          Math.max(PROBE_MIN, Math.round(PROBE_MAX * undecidedFrac)));
  return pool.slice(0, budget);
}

// ── inventory decision helpers (mirror evidence.py: prob_ge / decide / decidability) ──
// gammaln (Lanczos) → log C(n,k) so the exact integer-Beta tail never overflows.
function gammaln(x) {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
             771.32342877765313, -176.61502916214059, 12.507343278686905,
             -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - gammaln(1 - x);
  x -= 1; let a = c[0]; const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
const logChoose = (n, k) => gammaln(n + 1) - gammaln(k + 1) - gammaln(n - k + 1);

// P(prevalence ≥ θ) for a FLAT-prior Beta(1+conf, 1+deny); conf/deny are REPRESENTATIVE counts
// (the corroboration weight is existence evidence, not prevalence, so it must not bias this).
function probGe(conf, deny, theta = THETA) {
  conf = Number(conf); deny = Number(deny);            // pg returns bigint counts as strings — coerce
  const a = 1 + conf, n = a + (1 + deny) - 1;
  let cdfLe = 0;
  for (let j = a; j <= n; j++)
    cdfLe += Math.exp(logChoose(n, j) + j * Math.log(theta) + (n - j) * Math.log(1 - theta));
  return 1 - cdfLe;
}

// Four-state inventory decision (δ-stopping; self-terminating, no n cap).
function decide(conf, deny, { theta = THETA, c = C, delta = DELTA } = {}) {
  const p = probGe(conf, deny, theta);
  if (p >= c)     return 'IN';
  if (p <= 1 - c) return 'OUT';
  const belowTop = probGe(conf, deny, theta + delta) <= 1 - c;   // confident p < θ+δ
  const aboveBot = probGe(conf, deny, theta - delta) >= c;       // confident p > θ−δ
  return (belowTop && aboveBot) ? 'BOUNDARY' : 'UNDECIDED';
}

// Acquisition signal: distance to the nearer confidence bound (smaller ⇒ probe me next).
function decidability(conf, deny, { theta = THETA, c = C } = {}) {
  const p = probGe(conf, deny, theta);
  return Math.min(c - p, p - (1 - c));
}

// ── acquisition: representative PROBE selection over the bank ──
// Keep only UNDECIDED tasks (IN/OUT/BOUNDARY are resolved → p≈0, never re-shown); order them by
// DECIDABILITY (closest to a confidence bound first). Probes are UNFILTERED by relevance — that
// representativeness is what makes the in/out decision unbiased; engagement and recall come from
// generation/discovery, not from the bank. Order is randomized via a Gumbel-softmax over decidability
// (key = _dec/τ + log(−log U), ascending; τ=0 → deterministic) so concurrent participants reading the
// same posterior don't herd onto the same tasks. Key is computed ONCE per task.
// NOTE: decision uses REPRESENTATIVE counts — loadBank's task_posterior must filter is_probe=true.
function acquire(bankRows, { priorTasks = [] } = {}) {
  const prior = new Set((priorTasks || []).map(s => String(s).trim().toLowerCase()));
  const undecided = [];
  for (const r of bankRows) {
    if (prior.has(r.statement.trim().toLowerCase())) continue;
    const conf = Number(r.n_confirmed) || 0;
    const deny = (Number(r.n_shown) || 0) - conf;
    if (decide(conf, deny) !== 'UNDECIDED') continue;            // IN/OUT/BOUNDARY → resolved
    undecided.push({ ...r, _dec: decidability(conf, deny) });
  }
  return undecided
    .map(r => ({ r, k: PROBE_TAU > 0 ? r._dec / PROBE_TAU + Math.log(-Math.log(Math.random())) : r._dec }))
    .sort((a, b) => a.k - b.k)
    .map(({ r }) => ({ id: r.id, statement: r.statement, level: r.level, ai: r.ai,
                       isProbe: true, decidability: Number(r._dec.toFixed(4)) }));
}

export { pool, seedTasks, loadBank, nParticipants, recordResponse,
         stageGeneratedResponse, pickProbes, drainSession, acquire, decide, decidability,
         probGe };
