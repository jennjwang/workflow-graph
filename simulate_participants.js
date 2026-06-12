// Simulate participants flowing through the REAL acquisition loop (taskBank.js acquire/decide/
// decidability) over the ACTUAL 96-task bank. Shows, per participant, which bank PROBE tasks they
// see + their answers, and how the inventory's decision states evolve over time.
//
// Ground-truth prevalences are PLANTED (seeded, 3 buckets) — we have no real answers yet, so this
// demonstrates the MECHANICS, not real numbers. Generated/engagement tasks (~14/session, stashed
// offline) are not simulated; only the bank PROBE (decision) stream changes task states.
//
//   OPENAI_API_KEY=dummy DATABASE_URL=postgres://x node simulate_participants.js [N] [probes]
import { acquire, decide } from './taskBank.js';
import fs from 'fs';

const BANK_PATH = '/Users/jenniferwang/PhD/task_aggregation/results/new_tasks/task_bank_151252.json';
const bank = JSON.parse(fs.readFileSync(BANK_PATH, 'utf8')).tasks;

const N = Number(process.argv[2] || 60);
const PROBE_MAX = Number(process.argv[3] || 12);   // fatigue ceiling (mirrors taskBank.pickProbes)
const PROBE_MIN = 2;

// ADAPTIVE per-session probe budget — mirrors taskBank.pickProbes: spend more of the ceiling while
// more of the bank is undecided, taper to a floor as it resolves, bounded by what's actually undecided.
const probeBudget = (poolLen, total) =>
  poolLen ? Math.min(poolLen, Math.max(PROBE_MIN, Math.round(PROBE_MAX * (poolLen / total)))) : 0;

// deterministic RNG in [0,1) (FNV-1a) so the whole run is reproducible
const rnd = (...keys) => {
  let h = 2166136261; const s = keys.join('|');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 1_000_000) / 1_000_000;
};

// plant a true prevalence per task: 30% clearly core, 35% clearly not, 35% near-θ (the hard ones)
const truth = {};
for (const t of bank) {
  const r = rnd('plant', t.id), u = rnd('mag', t.id);
  truth[t.id] = r < 0.30 ? 0.78 + u * 0.20 : r < 0.65 ? 0.02 + u * 0.43 : 0.55 + u * 0.24;
}
const trueLabel = (id) => (truth[id] >= 0.67 ? 'IN' : 'OUT');
const does = (i, id) => (rnd('does', i, id) < truth[id] ? 1 : 0);   // worker i does task? Bernoulli

// evidence: representative probe counts per task
const ev = {}; for (const t of bank) ev[t.id] = { c: 0, d: 0 };
const rows = () => bank.map((t) => ({ id: t.id, statement: t.statement, weight: t.weight ?? 1,
  n_shown: ev[t.id].c + ev[t.id].d, n_confirmed: ev[t.id].c }));
const census = () => { const c = { IN: 0, OUT: 0, BOUNDARY: 0, UNDECIDED: 0 };
  for (const t of bank) c[decide(ev[t.id].c, ev[t.id].d)]++; return c; };
const clip = (s) => (s.length > 58 ? s.slice(0, 57) + '…' : s);

const nIN = bank.filter((t) => trueLabel(t.id) === 'IN').length;
console.log(`Bank: ${bank.length} tasks · planted truth: ${nIN} IN / ${bank.length - nIN} OUT · `
  + `${N} participants × adaptive probes (≤${PROBE_MAX}) · θ=0.67 c=0.95\n`);

const prev = {}; for (const t of bank) prev[t.id] = 'UNDECIDED';
for (let i = 1; i <= N; i++) {
  const pool = acquire(rows(), [], bank.length, { classifyFrac: 0 });   // all UNDECIDED, most-decidable first
  const probes = pool.slice(0, probeBudget(pool.length, bank.length));  // adaptive count

  if (i <= 3) {
    console.log(`── Participant ${i} sees ${probes.length} bank PROBE tasks `
      + `(adaptive; ${pool.length} undecided) (+ ~14 generated, not shown) ──`);
    for (const p of probes) {
      const a = does(i, p.id);
      console.log(`   ${a ? '✓ YES' : '✗ no '}  ${clip(p.statement).padEnd(58)} dec=${p.decidability}`);
    }
  }

  for (const p of probes) ev[p.id][does(i, p.id) ? 'c' : 'd']++;   // record answers

  const newly = [];
  for (const t of bank) { const s = decide(ev[t.id].c, ev[t.id].d);
    if (s !== prev[t.id] && s !== 'UNDECIDED') newly.push({ t, s }); prev[t.id] = s; }

  if (i <= 3 || i % 10 === 0 || i === N || newly.length) {
    const c = census();
    if (i <= 3 || i % 10 === 0 || i === N)
      console.log(`[n=${i}]  IN ${c.IN} · OUT ${c.OUT} · BOUNDARY ${c.BOUNDARY} · `
        + `UNDECIDED ${c.UNDECIDED}  (probe demand = ${c.UNDECIDED})`);
    for (const { t, s } of newly)
      console.log(`     → decided ${s}: ${clip(t.statement)}  [true ${trueLabel(t.id)}${trueLabel(t.id) === s ? '' : '  ✗MISMATCH'}]`);
    if (i <= 3 || i % 10 === 0 || i === N) console.log('');
  }
}

// final inventory + accuracy vs planted truth
const decided = bank.map((t) => ({ t, s: decide(ev[t.id].c, ev[t.id].d), c: ev[t.id].c, d: ev[t.id].d }));
const IN = decided.filter((x) => x.s === 'IN');
let correct = 0;
for (const x of decided) { const guess = x.s === 'IN' ? 'IN' : x.s === 'OUT' ? 'OUT'
  : (1 + x.c) / (2 + x.c + x.d) >= 0.67 ? 'IN' : 'OUT'; if (guess === trueLabel(x.t.id)) correct++; }

console.log(`\n══ CORE INVENTORY after ${N} participants (decided IN) ══`);
for (const x of IN.sort((a, b) => b.c - a.c))
  console.log(`   IN  (${x.c}✓/${x.d}✗)  ${clip(x.t.statement)}  [true ${trueLabel(x.t.id)}]`);
const watch = decided.filter((x) => x.s === 'UNDECIDED' && x.c >= 3).sort((a, b) => b.c - a.c).slice(0, 6);
if (watch.length) {
  console.log(`\n   closest-to-IN still UNDECIDED (need 7✓):`);
  for (const x of watch) console.log(`     (${x.c}✓/${x.d}✗)  ${clip(x.t.statement)}  [true ${trueLabel(x.t.id)}]`);
}
console.log(`\nClassification accuracy vs planted truth: ${(100 * correct / bank.length).toFixed(0)}%`);
