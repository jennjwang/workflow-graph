// Task-bank DB layer (PostgreSQL) for the active-learning task picker.
//
//   tasks      — read-mostly, seeded from the bank JSON artifact (seedTasks).
//   responses  — append-only participant answers (recordResponse).
//
// The Beta prevalence posterior + AI-exposure live in SQL views (schema.postgres.sql), so this
// module just reads/writes rows; acquire() runs the two-stream funnel (representative PROBE by
// decidability + relevance-gated CLASSIFY) over the UNDECIDED tasks. The decision logic here is
// a port of final/active_learning/evidence.py — mirrors draw_from_bank.py + evidence.py; keep in sync.
//
// Requires:  npm install pg   ·   env: DATABASE_URL   ·   ESM (matches server.js)
import pg from 'pg';
import fs from 'fs';
import OpenAI from 'openai';
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const REL_W = { high: 1.0, medium: 0.6, low: 0.3 };   // relevance multiplier (the classify gate)
const EMBED_MODEL = 'text-embedding-3-small';
const HARVEST_MATCH_SIM = Number(process.env.TASK_BANK_HARVEST_SIM || 0.6);  // cosine to merge a generated task
const ANNEAL_PARTICIPANTS = Number(process.env.ANNEAL_PARTICIPANTS || 20);

// ── inventory decision (PORT of final/active_learning/evidence.py — keep the two in sync) ──
// θ = O*NET Core bar · c = decision confidence · δ = indifference half-margin → BOUNDARY.
const THETA = Number(process.env.TASK_BANK_THETA ?? 0.67);
const C     = Number(process.env.TASK_BANK_C     ?? 0.95);
const DELTA = Number(process.env.TASK_BANK_DELTA ?? 0.12);
const CLASSIFY_FRAC = Number(process.env.TASK_BANK_CLASSIFY_FRAC ?? 0.4); // engagement reserve (anneals →0)
const PROBE_MAX = Number(process.env.TASK_BANK_PROBE_MAX ?? 12);  // fatigue ceiling: max probes / session
const PROBE_MIN = Number(process.env.TASK_BANK_PROBE_MIN ?? 2);   // floor while ANY task is still undecided

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
                                 aiExposure = null, isProbe = true }) {
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
      `INSERT INTO responses (participant, task, occupation, is_probe, response, ai_exposure)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [participant, taskId, occupation, isProbe, response, aiExposure]);
    await client.query('COMMIT');
    return { taskId, matched, sim: sim == null ? null : Number(sim) };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
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
// classifyFrac:0 → the bank contributes ONLY probes (the decision stream); the relevance-tailored
// engagement layer comes from generation (interview+gap), so no LLM relevance-gate is needed here.
//
// ADAPTIVE per-session budget (no fixed count): the bank is static within a study (harvest is off),
// so the principled signal is how much of it is still unresolved. Spend more of the fatigue ceiling
// while lots is undecided (probe hard to resolve the inventory), and cede slots to generation as it
// firms up — bounded by PROBE_MAX (fatigue) and by how many tasks are actually still UNDECIDED, with
// a PROBE_MIN trickle while any work remains. So probes/session = a demand-driven hump, not a constant.
async function pickProbes(occupation) {
  const rows = await loadBank(occupation);
  const pool = acquire(rows, [], rows.length, { classifyFrac: 0 });  // ALL undecided, most-decidable first
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

// ── acquisition: the two-stream funnel (see plan + simulate_active_learning.py) ──
// Bank-task slots split into TWO streams, both drawn ONLY from UNDECIDED tasks (IN/OUT/BOUNDARY
// are resolved → p≈0, never re-shown):
//   PROBE     — representative, UNFILTERED by relevance, prioritized by DECIDABILITY (closest to
//               crossing a confidence bound). The ONLY stream that moves the in/out decision →
//               is_probe:true. Demand-driven: capped by the number of UNDECIDED tasks, so probe
//               volume is a hump (high mid-study, ~0 once the inventory resolves).
//   CLASSIFY  — relevance-gated draw of UNDECIDED tasks the worker likely does. Engagement
//               scaffolding + existence/discovery only; does NOT move the decision → is_probe:false.
//               Reserve = classifyFrac·budget, annealed toward 0 (fades to a census as the core
//               set shrinks). Sim showed nearest-θ ('straddle') is pathological and decidability
//               wins under the scarce budget we actually run in.
// NOTE: decision uses REPRESENTATIVE counts — loadBank's task_posterior must be restricted to
// is_probe=true answers (schema task #2); repConf/repDeny below assume that.
//
// bankRows: loadBank() (ALL bank tasks).  selected: [{ id, relevance }] from the LLM gate.
// budget: bank-task slots.  opts.classifyFrac: engagement reserve (null → CLASSIFY_FRAC·(1−anneal)).
// opts.anneal: 0..1 maturity (e.g. lambdaFor()), scales the classify reserve toward 0.
function acquire(bankRows, selected, budget = 25,
                 { classifyFrac = null, anneal = 0, priorTasks = [] } = {}) {
  const prior = new Set((priorTasks || []).map(s => String(s).trim().toLowerCase()));
  const relOf = new Map(selected.map(s => [s.id, s.relevance]));

  // decision state from REPRESENTATIVE evidence; keep only the UNDECIDED (acquirable) tasks.
  const undecided = [];
  for (const r of bankRows) {
    if (prior.has(r.statement.trim().toLowerCase())) continue;
    const conf = Number(r.n_confirmed) || 0;
    const deny = (Number(r.n_shown) || 0) - conf;
    if (decide(conf, deny) !== 'UNDECIDED') continue;            // IN/OUT/BOUNDARY → resolved
    undecided.push({ ...r, _dec: decidability(conf, deny), relevance: relOf.get(r.id) ?? null });
  }
  if (!undecided.length) return [];

  const cap = budget > 0 ? Math.min(budget, undecided.length) : undecided.length;
  const a = Math.min(1, Math.max(0, anneal));
  const frac = classifyFrac == null ? CLASSIFY_FRAC * (1 - a) : classifyFrac;

  // CLASSIFY — relevance-gated, best relevance then most-decidable; capped by the reserve.
  const classifyPool = undecided.filter(r => r.relevance != null)
    .sort((x, y) => (REL_W[y.relevance] ?? 0) - (REL_W[x.relevance] ?? 0) || x._dec - y._dec);
  const nClassify = Math.min(Math.round(frac * cap), classifyPool.length);
  const classify = classifyPool.slice(0, nClassify);
  const classifyIds = new Set(classify.map(r => r.id));

  // PROBE — unfiltered, most-decidable first; fills the rest (gets classify's unspent slots too).
  const probe = [...undecided].sort((x, y) => x._dec - y._dec)
    .filter(r => !classifyIds.has(r.id)).slice(0, cap - classify.length);

  probe.forEach(r => { r.slot = 'probe'; r.isProbe = true; });
  classify.forEach(r => { r.slot = 'classify'; r.isProbe = false; });

  // Interleave so the unfiltered probes (some obviously-irrelevant) aren't a skippable block.
  const out = [];
  for (let i = 0; i < Math.max(probe.length, classify.length); i++) {
    if (i < probe.length) out.push(probe[i]);
    if (i < classify.length) out.push(classify[i]);
  }
  return out.map(r => ({ id: r.id, statement: r.statement, level: r.level, ai: r.ai,
                         relevance: r.relevance, slot: r.slot, isProbe: r.isProbe,
                         decidability: Number(r._dec.toFixed(4)) }));
}

export { pool, seedTasks, loadBank, nParticipants, lambdaFor, recordResponse,
         stageGeneratedResponse, pickProbes, harvestResponse, acquire, decide, decidability,
         probGe, REL_W };
