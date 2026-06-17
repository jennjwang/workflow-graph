// Task-bank DB layer (PostgreSQL) for the active-learning task picker.
//
//   tasks      — read-mostly, seeded from the bank JSON artifact (seedTasks).
//   responses  — append-only participant answers (recordResponse).
//
// The Beta prevalence posterior + AI-exposure live in SQL views (schema.postgres.sql), so this
// module just reads/writes rows; acquire() selects representative PROBES (knowledge-gradient-ordered:
// decidability discounted by the one-step P(this probe closes the decision)) over the UNDECIDED tasks.
// The decision logic here is a port of final/active_learning/evidence.py + simulate_active_learning.py
// (kg_value) — keep the two in sync.
//
// Requires:  npm install pg   ·   env: DATABASE_URL   ·   ESM (matches server.js)
import pg from 'pg';
import fs from 'fs';
import OpenAI from 'openai';
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const EMBED_MODEL = 'text-embedding-3-small';
// Harvest pool/insert mirrors Layer-2 aggregation (add_tasks / step6): the 5-way relationship CLASSIFIER
// decides, cosine is only a recall-safe PREFILTER (never the arbiter — cosine barely tracks the relation,
// AUC≈0.66, so the old 0.93/0.55 auto-bands mis-merged). NN retrieves top-K; drop anchors below FLOOR
// (clearly unrelated); classify the candidate vs each survivor; COVER (equivalence/is-a/part-of) → pool.
const HARVEST_SIM_FLOOR = Number(process.env.TASK_BANK_HARVEST_FLOOR ?? 0.20);  // recall-safe prefilter, NOT a decision band
const HARVEST_TOPK      = Number(process.env.TASK_BANK_HARVEST_TOPK  ?? 5);     // NN candidates to classify against
// 5-way classifier (port of relationships.classify_pair): K samples @ temp 0.7, A/B order alternated,
// majority vote. k=1 matches the incremental add_tasks path; raise for borderline robustness.
const CLASSIFY_MODEL  = process.env.TASK_BANK_CLASSIFY_MODEL ?? 'gpt-4o';
const CLASSIFY_K      = Number(process.env.TASK_BANK_CLASSIFY_K ?? 1);
const CLASSIFY_DOMAIN = process.env.TASK_BANK_CLASSIFY_DOMAIN ?? 'software work';
// FLAT-bank policy (A, decided): is-a/part-of POOL (collapse into the anchor) along with equivalence —
// the bank stays flat + compact, no hierarchy. Trade-off: a broad task fused with its kinds can blur
// distinct AI-exposure → MONITOR task_exposure.variance as the over-fusion flag (a high-variance node is
// a candidate to split). Switch to {equivalence} only if you want to keep kinds as separate exposure cells.
const COVER     = new Set(['equivalence', 'instantiation', 'composition']);  // pool; overlap/disjoint → insert
const _REL_RANK = { equivalence: 3, instantiation: 2, composition: 1 };       // best-cover tie-break
// Incremental closure (INCREMENTAL_CLOSURE.md): a freshly-harvested task that is equivalent to ≥2
// EXISTING tasks reveals those existing tasks are equivalent (a bridge) → consolidate them. Confidence-
// tiered apply: re-confirm the implied pair at CONFIRM_K (≥3) AND require the agreement gate to have
// signal+agree → apply online via mergeTasks; otherwise queue to pending_merges for the safe-window driver.
const CONFIRM_K         = Number(process.env.TASK_BANK_MERGE_CONFIRM_K  ?? 3);   // re-vote k before an online merge
const MERGE_MIN_OVERLAP = Number(process.env.TASK_BANK_MERGE_MIN_OVERLAP ?? 3);  // double-probed agreers for "strong"
// Existence gate (ACTIVE_LEARNING.md §3b): a task earns representative probes only once ≥k distinct
// participants have corroborated it via ANY channel (probe/mention/harvest). Below k it sits in the
// discovery pool (no probes) until another interview corroborates it. Graduation ≠ inclusion.
const MIN_CORROBORATORS = Number(process.env.TASK_BANK_MIN_CORROBORATORS ?? 2);
// VENDORED from task_aggregation/prompts/relationships/classifier_system.txt — keep in sync (this repo
// deploys standalone to Cloud Run, so it can't read the other repo at runtime).
const CLASSIFIER_SYSTEM = fs.readFileSync(new URL('./prompts/relationships/classifier_system.txt', import.meta.url), 'utf8')
  .replaceAll('{domain}', CLASSIFY_DOMAIN);

// ── inventory decision (PORT of final/active_learning/evidence.py — keep the two in sync) ──
// θ = O*NET Core bar · c = decision confidence · δ = indifference half-margin → BOUNDARY.
const THETA = Number(process.env.TASK_BANK_THETA ?? 0.67);
const C     = Number(process.env.TASK_BANK_C     ?? 0.95);
const DELTA = Number(process.env.TASK_BANK_DELTA ?? 0.12);
const PROBE_MAX = Number(process.env.TASK_BANK_PROBE_MAX ?? 12);  // fatigue ceiling: max probes / session
const PROBE_MIN = Number(process.env.TASK_BANK_PROBE_MIN ?? 2);   // floor while ANY task is still undecided
// Gumbel-softmax randomization of the KG-discounted decidability order (softmax temperature). Concurrent
// participants read the same posterior, so a DETERMINISTIC top-k herds them onto identical probes;
// τ>0 spreads the picks. Sim-validated: τ≈0.1 ties deterministic when sequential and ~4× better under
// heavy concurrency; KG discount keeps the score on decidability's scale so this τ transfers unchanged. 0 = deterministic.
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
            s.m, s.n AS n_nonment, s.x, x.corroborators,
            e.n AS exp_n, e.variance AS exp_var
       FROM tasks t
       JOIN task_posterior p ON p.id = t.id
       LEFT JOIN task_stratified s ON s.id = t.id
       LEFT JOIN task_existence x ON x.id = t.id
       LEFT JOIN task_exposure e ON e.task = t.id
      WHERE t.occupation = $1 AND t.status <> 'retired'`,
    [occupation]);
  const N = await nParticipants(occupation);          // mention-floor denominator (distinct participants)
  for (const r of rows) { r.N = N; r.corroborators = Number(r.corroborators) || 0; }
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
// embed → pgvector NN PREFILTER (≥ FLOOR) → 5-way relationship CLASSIFIER cover policy → pool onto an
// existing task (COVER = equivalence/is-a/part-of; bump its weight, existence corroboration) or INSERT a
// new cold 'emergent' candidate (overlap/disjoint). It NEVER writes `responses`, so these relevance-gated
// confirmations grow recall but do NOT move the representative DECISION. Serialized cluster-wide by a
// per-occupation pg advisory lock so two simultaneous drains can't double-insert the same new task (the
// 2nd blocks, then finds the 1st's insert via NN and pools).
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


// 5-way relationship classifier — the SAME arbiter as Layer-2 aggregation (relationships.classify_pair).
// K samples @ temp 0.7 with the A/B display order ALTERNATED (order-bias control; direction un-flipped on
// swap), majority vote over the five labels. Returns {label, conf, parent} where parent ∈ {'a','b',null}
// is which ARGUMENT is the broader/whole for is-a/part-of. On any API/parse error a sample defaults to
// 'disjoint' (conservative → insert rather than wrongly pool). a = the NEW (candidate) statement, b = anchor.
async function classifyRelation(aText, bText, { k = CLASSIFY_K } = {}) {
  const votes = {}, dirs = {};
  for (let s = 0; s < k; s++) {
    const swap = s % 2 === 1;                          // alternate orientation across samples
    const user = swap ? `A: ${bText}\nB: ${aText}` : `A: ${aText}\nB: ${bText}`;
    let label = 'disjoint', dir = null;
    try {
      const r = await openai.chat.completions.create({
        model: CLASSIFY_MODEL, temperature: 0.7, max_tokens: 120,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: CLASSIFIER_SYSTEM }, { role: 'user', content: user }],
      });
      const o = JSON.parse(r.choices[0].message.content);
      label = o.relationship || 'disjoint';
      dir = o.direction || null;
      if (swap && dir === 'a_is_parent') dir = 'b_is_parent';       // un-flip to original orientation
      else if (swap && dir === 'b_is_parent') dir = 'a_is_parent';
    } catch { /* default disjoint → conservative insert */ }
    votes[label] = (votes[label] || 0) + 1;
    if (dir) dirs[dir] = (dirs[dir] || 0) + 1;
  }
  const [label, v] = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
  let parent = null;
  if ((label === 'instantiation' || label === 'composition') && Object.keys(dirs).length) {
    const [d] = Object.entries(dirs).sort((a, b) => b[1] - a[1])[0];
    parent = d === 'a_is_parent' ? 'a' : 'b';
  }
  return { label, conf: v / k, parent };
}

// upsert one undirected relationship edge (canonical a < b) into the persisted graph (the cache that
// makes closure incremental). parentId = the broader/whole task id for is-a/part-of, else null.
async function persistEdge(client, occupation, x, y, label, conf, parentId) {
  const [a, b] = x < y ? [x, y] : [y, x];
  await client.query(
    `INSERT INTO task_relationships (occupation, a, b, label, parent, conf, k)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (occupation, a, b) DO UPDATE
       SET label = EXCLUDED.label, parent = EXCLUDED.parent, conf = EXCLUDED.conf,
           k = EXCLUDED.k, classified_at = now()`,
    [occupation, a, b, label, parentId ?? null, conf ?? null, CLASSIFY_K]);
}

// match-or-insert ONE statement (embedding precomputed). Must run under the advisory lock.
// Cosine NN is a recall-safe PREFILTER only; the 5-way CLASSIFIER arbitrates pool vs insert (cover policy,
// mirroring add_tasks/step6). COVER (equivalence/is-a/part-of, either direction) → pool onto the best
// covering anchor (prefer equivalence, then highest cosine); overlap/disjoint on all survivors → insert.
async function harvestOne(client, occupation, statement, emb) {
  const nn = await client.query(
    `SELECT id, statement, 1 - (embedding <=> $2::vector) AS sim
       FROM tasks WHERE occupation = $1 AND embedding IS NOT NULL AND status <> 'retired'
       ORDER BY embedding <=> $2::vector LIMIT $3`,
    [occupation, vlit(emb), HARVEST_TOPK]);
  const anchors = nn.rows.filter(r => Number(r.sim) >= HARVEST_SIM_FLOOR);   // recall-safe prefilter (not a decision)
  const rels = [];                                                          // classify n vs each survivor
  for (const a of anchors) {
    const r = await classifyRelation(statement, a.statement);              // a = new statement, b = anchor
    rels.push({ id: a.id, sim: Number(a.sim), label: r.label, conf: r.conf, parent: r.parent });
  }
  const covers = rels.filter(r => COVER.has(r.label));
  const equivCovers = rels.filter(r => r.label === 'equivalence').map(r => r.id);  // existing tasks n ≡ (bridge signal)

  if (covers.length) {                                                       // pool: +1 existence corroboration (weight)
    covers.sort((x, y) => (_REL_RANK[y.label] - _REL_RANK[x.label]) || (y.sim - x.sim));
    const matchId = covers[0].id;
    await client.query('UPDATE tasks SET weight = weight + 1 WHERE id = $1', [matchId]);
    if (equivCovers.length > 1) {                                            // n bridges ≥2 existing tasks → persist inferred edges
      for (let i = 0; i < equivCovers.length; i++)
        for (let j = i + 1; j < equivCovers.length; j++)
          await persistEdge(client, occupation, equivCovers[i], equivCovers[j], 'equivalence', null, null);
    }
    return { taskId: matchId, matched: true, action: `pool-${covers[0].label}`, equivCovers };
  }
  const taskId = 'E' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  await client.query(                                  // insert: new cold candidate (UNDECIDED, weight 1)
    `INSERT INTO tasks (id, occupation, statement, source, weight, status, embedding)
     VALUES ($1,$2,$3,'emergent',1,'active',$4::vector)`,
    [taskId, occupation, statement, vlit(emb)]);
  for (const r of rels) {                              // persist n's classified edges (n is now a persistent node)
    const parentId = r.parent === 'a' ? taskId : r.parent === 'b' ? r.id : null;
    await persistEdge(client, occupation, taskId, r.id, r.label, r.conf, parentId);
  }
  return { taskId, matched: false, action: anchors.length ? 'insert-no-cover' : 'insert-no-anchor', equivCovers: [] };
}

// union-find over the equivalence-bridge sets collected during a drain → merge proposals {keep,drop}
// (keep = min id per component). Each set is the existing tasks one harvested statement was ≡ to.
function bridgesToProposals(sets) {
  const parent = new Map();
  const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const add = x => { if (!parent.has(x)) parent.set(x, x); };
  const union = (x, y) => { add(x); add(y); parent.set(find(x), find(y)); };
  for (const s of sets) for (let i = 1; i < s.length; i++) union(s[0], s[i]);
  const comps = new Map();
  for (const x of parent.keys()) { const r = find(x); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(x); }
  const proposals = [];
  for (const members of comps.values()) {
    if (members.length < 2) continue;
    const sorted = [...members].sort();
    for (const drop of sorted.slice(1)) proposals.push({ keep: sorted[0], drop });
  }
  return proposals;
}

// CONFIDENCE-TIERED apply of one proposed existing×existing consolidation. Re-confirm the pair at
// CONFIRM_K and require the agreement gate to have signal AND full agreement → apply ONLINE via
// mergeTasks (which takes its own advisory lock — call this AFTER drainSession releases the lock to
// avoid re-entrant deadlock). Otherwise QUEUE to pending_merges for the safe-window driver.
async function applyOrQueueMerge(occupation, keepId, dropId) {
  const { rows } = await pool.query(
    `SELECT id, statement FROM tasks WHERE id = ANY($1) AND status <> 'retired'`, [[keepId, dropId]]);
  if (rows.length !== 2) return 'skip';                                      // one already merged away
  const keep = rows.find(r => r.id === keepId), drop = rows.find(r => r.id === dropId);
  const rel = await classifyRelation(keep.statement, drop.statement, { k: CONFIRM_K });   // higher-k re-vote
  const ag = await mergeAgreement(pool, keepId, dropId);                     // double-probed behavioral signal
  const strong = rel.label === 'equivalence' && rel.conf >= 0.6              // k≥3 majority equivalence
                 && ag.both >= MERGE_MIN_OVERLAP && ag.rate === 1;           // gate has signal AND all agree
  if (strong) {
    try {
      const r = await mergeTasks(occupation, keepId, dropId, { gate: true });
      if (r.merged) return 'applied';
    } catch { /* fall through to queue */ }
  }
  await pool.query(                                                          // uncertain → queue for review
    `INSERT INTO pending_merges (occupation, keep_id, drop_id, reason, agreement)
     VALUES ($1,$2,$3,'equivalence-bridge',$4)`,
    [occupation, keepId, dropId, JSON.stringify({ ...ag, confirm: rel })]);
  return 'queued';
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
  let inserted = 0, pooled = 0;
  const bridgeSets = [];                               // existing-task equivalence sets revealed this drain
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [occupation]);   // serialize bank writes
    try {
      for (let i = 0; i < pend.length; i++) {
        const res = await harvestOne(client, occupation, pend[i].statement, embs[i]);
        await client.query('UPDATE generated_responses SET harvested_at = now(), harvested_task = $2 WHERE id = $1',
          [pend[i].id, res.taskId]);
        res.matched ? pooled++ : inserted++;
        if (res.equivCovers && res.equivCovers.length > 1) bridgeSets.push(res.equivCovers);
      }
      await client.query(                              // DENIES: mark processed, no bank action
        `UPDATE generated_responses SET harvested_at = now()
          WHERE occupation = $1 AND participant = $2 AND harvested_at IS NULL`, [occupation, participant]);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [occupation]).catch(() => {});
    }
  } finally { client.release(); }

  // POST-LOCK: existing×existing consolidation (incremental closure). mergeTasks takes its OWN advisory
  // lock, so this must run after the lock above is released (avoid re-entrant deadlock). Confidence-tiered:
  // strong bridges apply online here, uncertain ones queue to pending_merges (see applyOrQueueMerge).
  let mergedOnline = 0, queued = 0;
  for (const { keep, drop } of bridgesToProposals(bridgeSets)) {
    const r = await applyOrQueueMerge(occupation, keep, drop);
    if (r === 'applied') mergedOnline++;
    else if (r === 'queued') queued++;
  }
  return { merged: pend.length, inserted, pooled, bridges: bridgeSets.length, mergedOnline, queued };
}

// Safe-window driver for the UNCERTAIN tier: drain pending_merges via mergeTasks. Run between collection
// waves (the merges retire tasks; doing it while serving risks straggler answers landing on retired ids).
// dryRun lists what would happen; gate=true re-applies the agreement gate at apply time (signal may have
// accrued since the proposal). Returns one record per proposal.
async function applyPendingMerges(occupation, { dryRun = false, gate = false } = {}) {
  const { rows } = await pool.query(
    `SELECT id, keep_id, drop_id, agreement FROM pending_merges
      WHERE occupation = $1 AND status = 'pending' ORDER BY id`, [occupation]);
  const out = [];
  for (const m of rows) {
    if (dryRun) { out.push({ id: m.id, keep: m.keep_id, drop: m.drop_id, action: 'dry-run' }); continue; }
    let r;
    try { r = await mergeTasks(occupation, m.keep_id, m.drop_id, { gate }); }
    catch (e) { r = { merged: false, reason: e.message }; }
    const status = r.merged ? 'applied' : 'rejected';
    await pool.query('UPDATE pending_merges SET status = $2, applied_at = now() WHERE id = $1', [m.id, status]);
    out.push({ id: m.id, keep: m.keep_id, drop: m.drop_id, status, reason: r.reason });
  }
  return out;
}

// ── merge two EXISTING bank tasks (curation cleanup of a harvest false-negative: keep & drop turned
//    out equivalent, each already carries probe history). Merging is an EVENT-LEVEL relabel, NOT a
//    count add — adding the two posteriors would double-count any worker who answered both. We relabel
//    drop's events to keep; task_posterior's DISTINCT ON (participant, task) ... id DESC then collapses
//    each double-answering participant to their LATEST answer for free (the per-account probe collapse).
//    Fold drop's weight (Beta prior) into keep and RETIRE drop — never DELETE: responses.task is a FK,
//    so retiring keeps it valid against any in-flight write-back (the schema's seed-hazard note). The
//    advisory lock serializes vs drainSession (same write-write class) but NOT vs the lock-free
//    recordResponse hot path, so a straggler answer on drop mid-merge stays on the retired id and is
//    simply excluded from serving/decision (loadBank filters status<>'retired') — rare, off-hours op.
//
//    AGREEMENT GATE — OFF by default (gate=false): merging is an operator-initiated curation step, so a
//    human eyeballs the returned `agreement` rate and the double-probed overlap is usually too thin to
//    threshold. Set gate=true to auto-refuse when ≥ minOverlap participants probed on both and the
//    agreement rate < minAgreement (equivalence suspect; below minOverlap no signal → proceed). Turn it
//    ON if merging is ever AUTOMATED (no operator). Mirrors evidence.merge_agreement / merge_tasks.
async function mergeAgreement(client, keep, drop) {           // probe-stream agreement on double-answerers
  const { rows } = await client.query(
    `WITH latest AS (
        SELECT DISTINCT ON (participant, task) participant, task, response
          FROM responses WHERE is_probe AND task = ANY($1)
          ORDER BY participant, task, id DESC),
     pp AS (
        SELECT participant,
               max(response) FILTER (WHERE task = $2) AS rk,
               max(response) FILTER (WHERE task = $3) AS rd
          FROM latest GROUP BY participant)
     SELECT count(*) FILTER (WHERE rk IS NOT NULL AND rd IS NOT NULL)             AS both,
            count(*) FILTER (WHERE rk IS NOT NULL AND rd IS NOT NULL AND rk = rd) AS agree
       FROM pp`,
    [[keep, drop], keep, drop]);
  const both = Number(rows[0].both), agree = Number(rows[0].agree);
  return { both, agree, rate: both ? agree / both : null };
}

function unionProvenance(a, b) {                               // union jsonb corroborated_by lists, dedup
  const arr = x => (Array.isArray(x) ? x : (x ? [x] : []));
  const out = [...arr(a)];
  for (const c of arr(b)) if (!out.some(o => JSON.stringify(o) === JSON.stringify(c))) out.push(c);
  return out;
}

async function mergeTasks(occupation, keepId, dropId,
                          { gate = false, minOverlap = 3, minAgreement = 0.7 } = {}) {
  if (!occupation || !keepId || !dropId) throw new Error('mergeTasks needs occupation + keepId + dropId');
  if (keepId === dropId) throw new Error('mergeTasks: keepId and dropId are the same task');
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [occupation]);   // serialize bank writes
    try {
      const { rows: t } = await client.query(                  // both must be live tasks in this occupation
        `SELECT id, weight, corroborated_by FROM tasks
          WHERE occupation = $1 AND id = ANY($2) AND status <> 'retired'`,
        [occupation, [keepId, dropId]]);
      if (t.length !== 2) throw new Error(`mergeTasks: ${keepId}/${dropId} not both active in ${occupation}`);

      const ag = await mergeAgreement(client, keepId, dropId);                    // gate (read, pre-write)
      if (gate && ag.both >= minOverlap && ag.rate < minAgreement)
        return { merged: false, reason: 'low_agreement', agreement: ag };

      const keep = t.find(r => r.id === keepId), drop = t.find(r => r.id === dropId);
      const weight = Math.max(1, Number(keep.weight) + Number(drop.weight) - 1);  // combine priors, drop shared base
      const corr = unionProvenance(keep.corroborated_by, drop.corroborated_by);
      await client.query('BEGIN');
      await client.query('UPDATE responses           SET task = $1           WHERE task = $2', [keepId, dropId]);
      await client.query('UPDATE generated_responses SET harvested_task = $1  WHERE harvested_task = $2', [keepId, dropId]);
      await client.query('UPDATE tasks SET weight = $2, corroborated_by = $3 WHERE id = $1',
        [keepId, weight, JSON.stringify(corr)]);
      await client.query("UPDATE tasks SET status = 'retired' WHERE id = $1", [dropId]);
      await client.query('COMMIT');
      return { merged: true, reason: 'ok', agreement: ag, keepId, dropId, weight };
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [occupation]).catch(() => {}); }
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
// Match a worker's SPONTANEOUS interview tasks to bank ids for evidence credit, using the SAME 5-way
// relationship classifier as harvest (not a binary same-task check). Returns Map(statement → {id, credit}).
// `credit` is set by whether DOING the worker's task necessarily means doing the bank task:
//   full    — equivalence; is-a where the BANK task is the parent (a kind ⟹ its parent); part-of where
//             the WORKER's task is the whole (the whole ⟹ its component). → recorded as a prevalence MENTION.
//   partial — part-of where the BANK task is the whole (worker did only a component) → EXISTENCE only,
//             not prevalence (doing a part ⇏ doing the whole).
//   no match — is-a where the worker's task is the broader one, overlap, disjoint → a different task.
// Embedding NN is a recall-safe prefilter (≥ FLOOR); the classifier arbitrates. No lock (pure reads).
const _CREDIT_RANK = { full: 2, partial: 1 };
function _mentionCredit(label, parent) {           // parent: 'a' = worker-stmt is broader/whole, 'b' = bank anchor is
  if (label === 'equivalence') return 'full';
  if (label === 'instantiation') return parent === 'b' ? 'full' : null;      // anchor is parent → stmt is a kind ⟹ doer of anchor
  if (label === 'composition')   return parent === 'a' ? 'full' : 'partial'; // stmt is whole ⟹ does anchor part; else stmt is a part of anchor
  return null;                                                               // overlap / disjoint
}
async function matchToBankIds(occupation, statements) {
  const clean = [...new Set((statements || []).map(s => String(s).trim()).filter(Boolean))];
  if (!clean.length) return new Map();
  const embs = await embedMany(clean);
  const pairs = await Promise.all(clean.map(async (stmt, i) => {
    const { rows } = await pool.query(
      `SELECT id, statement, 1 - (embedding <=> $2::vector) AS sim
         FROM tasks WHERE occupation = $1 AND embedding IS NOT NULL AND status <> 'retired'
         ORDER BY embedding <=> $2::vector LIMIT $3`,            // NN = retrieval only; classifier decides below
      [occupation, vlit(embs[i]), HARVEST_TOPK]);
    const cands = [];
    for (const a of rows) {
      if (Number(a.sim) < HARVEST_SIM_FLOOR) continue;          // recall-safe prefilter (not a decision)
      const rel = await classifyRelation(stmt, a.statement);    // a = worker stmt, b = bank anchor
      const credit = _mentionCredit(rel.label, rel.parent);
      if (credit) cands.push({ id: a.id, sim: Number(a.sim), eq: rel.label === 'equivalence', credit });
    }
    if (!cands.length) return null;
    cands.sort((x, y) => (_CREDIT_RANK[y.credit] - _CREDIT_RANK[x.credit]) || (y.eq - x.eq) || (y.sim - x.sim));
    return [stmt, { id: cands[0].id, credit: cands[0].credit }];
  }));
  return new Map(pairs.filter(Boolean));
}

// Record an EXISTENCE-only corroboration (no prevalence): a worker volunteered a PART of this bank task,
// which corroborates the task is real but NOT that they do the whole. Written to the existence channel
// (generated_responses, pre-marked harvested to `task`) so task_existence counts it while the prevalence
// ledger (responses / task_stratified) does not.
async function recordCorroboration({ participant, task, occupation = null, statement = null }) {
  await pool.query(
    `INSERT INTO generated_responses (participant, occupation, statement, source, response, harvested_at, harvested_task)
     VALUES ($1,$2,$3,'mention-partof','confirm',now(),$4)`,
    [participant, occupation, statement || '(part-of mention)', task]);
}

async function pickProbes(occupation, { coveredIds = new Set() } = {}) {
  const rows = await loadBank(occupation);
  const pool = acquire(rows, { priorIds: coveredIds });             // undecided & NOT already volunteered
  if (coveredIds.size) console.log(`[pickProbes] ${occupation}: deduped ${coveredIds.size} volunteered task(s)`);
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

// Four-state inventory decision — ANYTIME-VALID e-process (mirror evidence.py `decide`; valid under the
// loop's continuous monitoring, unlike the single-look fixed-sample probGe≥c rule, which over-rejects when
// you peek every participant). δ-stopping, no n cap. `logEprocess` is defined in the stratified block below
// (hoisted). Used by the simulator + kgValue's terminal check; production decides via decideStratified.
function decide(conf, deny, { theta = THETA, c = C, delta = DELTA } = {}) {
  const thr = Math.log(1 / (1 - c));
  if (logEprocess(conf, deny, 'in',  theta) >= thr) return 'IN';
  if (logEprocess(conf, deny, 'out', theta) >= thr) return 'OUT';
  const belowTop = logEprocess(conf, deny, 'out', theta + delta) >= thr;  // certify p < θ+δ
  const aboveBot = logEprocess(conf, deny, 'in',  theta - delta) >= thr;  // certify p > θ−δ
  return (belowTop && aboveBot) ? 'BOUNDARY' : 'UNDECIDED';
}

// Acquisition signal: distance to the nearer confidence bound (smaller ⇒ probe me next).
function decidability(conf, deny, { theta = THETA, c = C } = {}) {
  const p = probGe(conf, deny, theta);
  return Math.min(c - p, p - (1 - c));
}

// One-step KNOWLEDGE GRADIENT (mirror simulate_active_learning.py `kg_value`): P(the next representative
// answer CLOSES the decision). A probe of (conf,deny) confirms w.p. p̂→(conf+1,deny) or denies→(conf,deny+1),
// and kg = the probability that one such probe makes the task terminal (IN/OUT/BOUNDARY). It is the exact
// expected-decisions-closed objective that `decidability` approximates (validated ≈-equivalent). Used to
// DISCOUNT decidability in acquire(): a task can only resolve in one step when it is ALREADY near a bound, so
// dist·(1−kg) sharpens the order among about-to-resolve tasks while staying on decidability's [0,C−½] scale.
function kgValue(conf, deny, { theta = THETA, c = C, delta = DELTA } = {}) {
  conf = Number(conf); deny = Number(deny);
  const phat = (1 + conf) / (2 + conf + deny);
  const term = (x, y) => (decide(x, y, { theta, c, delta }) !== 'UNDECIDED' ? 1 : 0);
  return phat * term(conf + 1, deny) + (1 - phat) * term(conf, deny + 1);
}

// ── STRATIFIED two-stream decision (PORT of evidence.py decide_stratified et al. — keep in sync) ──
// The single-stream `decide` above reads only representative probes. The CANONICAL inventory decision
// stratifies by MENTION: a mention (is_probe=false confirm) is a certain doer (never probed), so
//   p̂ = m/N + (1 − m/N)·x/n   — mention stratum (size m/N, doer-fraction 1) + non-mention probe stratum
// (size 1−m/N, doer-fraction q=x/n). Anytime-valid: a confidence sequence on each stratum (split α by a
// union bound), combined through the monotone p = π₁+(1−π₁)q. Mentions promote (Verdict A floor m/N) but
// can never force OUT. `lgamma` (Lanczos) → `logBeta` → mixture e-process → CS by bisection.
const _LG = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
             -176.61502916214059, 12.507343278686905, -0.13857109526572012,
             9.9843695780195716e-6, 1.5056327351493116e-7];
function lgamma(z) {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1;
  let a = _LG[0]; const t = z + 7.5;
  for (let i = 1; i < 9; i++) a += _LG[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}
const logBeta = (a, b) => lgamma(a) + lgamma(b) - lgamma(a + b);

// log mixture e-value for one direction; side='in' tests p>θ, side='out' tests p<θ (Ville anytime-valid).
function logEprocess(conf, deny, side, theta = THETA) {
  const tail = side === 'in' ? probGe(conf, deny, theta) : 1 - probGe(conf, deny, theta);
  if (tail <= 0) return -Infinity;
  const norm = side === 'in' ? (1 - theta) : theta;          // prior mass on the alternative side
  return Math.log(tail) + logBeta(conf + 1, deny + 1)
         - conf * Math.log(theta) - deny * Math.log(1 - theta) - Math.log(norm);
}

// anytime-valid confidence sequence [L,U] on a Bernoulli mean from (conf,deny), inverting the e-process.
function eprocessCs(conf, deny, c = C, iters = 60) {
  const thr = Math.log(1 / (1 - c)), lo0 = 1e-9, hi0 = 1 - 1e-9;
  let L = 0;
  if (logEprocess(conf, deny, 'in', lo0) >= thr) {           // e_in decreasing in θ
    let lo = lo0, hi = hi0;
    for (let i = 0; i < iters; i++) { const mid = 0.5 * (lo + hi); if (logEprocess(conf, deny, 'in', mid) >= thr) lo = mid; else hi = mid; }
    L = lo;
  }
  let U = 1;
  if (logEprocess(conf, deny, 'out', hi0) >= thr) {           // e_out increasing in θ
    let lo = lo0, hi = hi0;
    for (let i = 0; i < iters; i++) { const mid = 0.5 * (lo + hi); if (logEprocess(conf, deny, 'out', mid) >= thr) hi = mid; else lo = mid; }
    U = hi;
  }
  return [L, U];
}

const phatStratified = (N, m, n, x) => { const pi1 = N ? m / N : 0, q = n ? x / n : 0; return pi1 + (1 - pi1) * q; };

// Four-state inventory decision from STRATIFIED counts (N interviewed, m mentioned, n non-mentioners
// probed, x of them confirmed). Mirrors evidence.py decide_stratified.
function decideStratified(N, m, n, x, { theta = THETA, c = C, delta = DELTA } = {}) {
  N = Number(N) || 0; m = Math.min(Number(m) || 0, N); n = Number(n) || 0; x = Number(x) || 0;
  const cc = 1 - (1 - c) / 2;                                 // union bound: α/2 per stratum
  const [Lpi, Upi] = N > 0 ? eprocessCs(m, N - m, cc) : [0, 1];
  const [Lq, Uq]   = n > 0 ? eprocessCs(x, n - x, cc) : [0, 1];
  const Lp = Lpi + (1 - Lpi) * Lq, Up = Upi + (1 - Upi) * Uq;
  if (Lp >= theta) return 'IN';
  if (Up <= theta) return 'OUT';
  if (Lp >= theta - delta && Up <= theta + delta) return 'BOUNDARY';
  return 'UNDECIDED';
}

// Acquisition priority for the stratified decision: distance of the prevalence CS to a terminal call
// (smaller ⇒ probe next). A probe only moves the non-mention stratum.
function decidabilityStratified(N, m, n, x, { theta = THETA, c = C } = {}) {
  N = Number(N) || 0; m = Math.min(Number(m) || 0, N); n = Number(n) || 0; x = Number(x) || 0;
  const cc = 1 - (1 - c) / 2;
  const [Lpi, Upi] = N > 0 ? eprocessCs(m, N - m, cc) : [0, 1];
  const [Lq, Uq]   = n > 0 ? eprocessCs(x, n - x, cc) : [0, 1];
  const Lp = Lpi + (1 - Lpi) * Lq, Up = Upi + (1 - Upi) * Uq;
  return Math.min(Math.abs(Up - theta), Math.abs(Lp - theta));
}

// ── acquisition: representative PROBE selection over the bank ──
// Keep only UNDECIDED tasks (IN/OUT/BOUNDARY are resolved → p≈0, never re-shown); order them by the
// KNOWLEDGE-GRADIENT-discounted decidability score dist·(1−kg) (smallest ⇒ probe me next — exact one-step
// expected-decisions-closed; closest to a confidence bound first, sharpened by the probability the next
// probe actually closes the call). Probes are UNFILTERED by relevance — that representativeness is what
// makes the in/out decision unbiased; engagement and recall come from generation/discovery, not the bank.
// Order is randomized via a Gumbel-softmax over the score (key = score/τ + log(−log U), ascending; τ=0 →
// deterministic) so concurrent participants reading the same posterior don't herd. Score computed ONCE/task.
// NOTE: decision uses REPRESENTATIVE counts — loadBank's task_posterior must filter is_probe=true.
function acquire(bankRows, { priorTasks = [], priorIds = null } = {}) {
  const prior = new Set((priorTasks || []).map(s => String(s).trim().toLowerCase()));
  const exclude = priorIds instanceof Set ? priorIds : new Set(priorIds || []);  // bank ids already covered
  const undecided = [];
  for (const r of bankRows) {
    if (exclude.has(r.id)) continue;                              // worker already volunteered this task (mention-skip)
    if (prior.has(r.statement.trim().toLowerCase())) continue;
    if (r.corroborators !== undefined && Number(r.corroborators) < MIN_CORROBORATORS) continue;  // discovery pool: < k corroborators → no representative probes
    // STRATIFIED when loadBank supplied (N,m,n,x); else single-stream (the simulator builds n_shown/n_confirmed only).
    const strat = r.N !== undefined && r.m !== undefined && r.x !== undefined;
    if (strat) {
      const N = Number(r.N) || 0, m = Number(r.m) || 0, n = Number(r.n_nonment) || 0, x = Number(r.x) || 0;
      if (decideStratified(N, m, n, x) !== 'UNDECIDED') continue;          // IN/OUT/BOUNDARY → resolved
      const dec = decidabilityStratified(N, m, n, x);
      undecided.push({ ...r, _dec: dec, _score: dec, _boot: n > 0 });      // never-probed (n=0) → breadth bootstrap
    } else {
      const conf = Number(r.n_confirmed) || 0;
      const deny = (Number(r.n_shown) || 0) - conf;
      if (decide(conf, deny) !== 'UNDECIDED') continue;
      const dec = decidability(conf, deny);
      undecided.push({ ...r, _dec: dec, _score: dec * (1 - kgValue(conf, deny)), _boot: true });
    }
  }
  return undecided
    // breadth bootstrap tier first (never-probed graduated arms), then KG/decidability with Gumbel anti-herding
    .map(r => ({ r, tier: r._boot ? 1 : 0,
                 k: PROBE_TAU > 0 ? r._score / PROBE_TAU + Math.log(-Math.log(Math.random())) : r._score }))
    .sort((a, b) => (a.tier - b.tier) || (a.k - b.k))
    .map(({ r }) => ({ id: r.id, statement: r.statement, level: r.level, ai: r.ai,
                       isProbe: true, decidability: Number(r._dec.toFixed(4)),
                       kgScore: Number(r._score.toFixed(4)) }));
}

export { pool, seedTasks, loadBank, nParticipants, recordResponse,
         stageGeneratedResponse, pickProbes, matchToBankIds, recordCorroboration, drainSession, mergeTasks, mergeAgreement,
         applyPendingMerges, classifyRelation, persistEdge, bridgesToProposals,
         acquire, decide, decidability, kgValue, probGe,
         decideStratified, decidabilityStratified, phatStratified, eprocessCs };
