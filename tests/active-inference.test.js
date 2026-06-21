// Validates the JS PPI port (activeInference.js) against reference values computed by the Python
// reference (final/active_learning/batch_active.py active_cs / active_estimate). Grid resolution is
// 1e-3, so bounds are asserted to ±2e-3. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeCs, activeEstimate } from '../activeInference.js';

// Deterministic case: n total non-mentioners (all f=fval), first nprobe probed, first conf of them confirm.
function mkCase(n, fval, nprobe, conf, pi) {
  const f = Array(n).fill(fval), xi = [], y = [], piA = Array(n).fill(pi);
  for (let i = 0; i < n; i++) { xi.push(i < nprobe ? 1 : 0); y.push(i < conf ? 1 : 0); }
  return { f, y, xi, pi: piA };
}

// Reference values from batch_active.active_cs (see commit / git history of evidence work).
const REF = [
  { name: 'A low-prevalence',  n: 100, fval: 0.25, nprobe: 40, conf: 8,  pi: 0.4, alpha: 0.05, qhat: 0.200, L: 0.035, U: 0.516 },
  { name: 'B high-prevalence', n: 120, fval: 0.75, nprobe: 50, conf: 40, pi: 0.4, alpha: 0.05, qhat: 0.802, L: 0.569, U: 1.000 },
  { name: 'C mid, looser α',   n: 80,  fval: 0.50, nprobe: 30, conf: 15, pi: 0.4, alpha: 0.10, qhat: 0.500, L: 0.273, U: 0.831 },
];

for (const r of REF) {
  test(`activeCs matches Python — ${r.name}`, () => {
    const { f, y, xi, pi } = mkCase(r.n, r.fval, r.nprobe, r.conf, r.pi);
    assert.ok(Math.abs(activeEstimate(f, y, xi, pi) - r.qhat) < 1e-3, `qhat js=${activeEstimate(f, y, xi, pi)}`);
    const [L, U] = activeCs(f, y, xi, pi, r.alpha);
    assert.ok(Math.abs(L - r.L) < 2e-3, `L: js=${L.toFixed(4)} py=${r.L}`);
    assert.ok(Math.abs(U - r.U) < 2e-3, `U: js=${U.toFixed(4)} py=${r.U}`);
  });
}

test('activeCs is [0,1] with no data and tightens vs raw counts at equal probes', () => {
  assert.deepEqual(activeCs([], [], [], [], 0.05), [0, 1]);
  // a GOOD f (predicts the 40 probes' outcome) + 60 unprobed baselines → narrower than a 40-only binomial
  const f = [], y = [], xi = [], pi = [];
  for (let i = 0; i < 100; i++) {
    const doer = i % 10 < 3 ? 1 : 0;               // true q = 0.30
    f.push(doer ? 0.8 : 0.2); y.push(doer); xi.push(i < 40 ? 1 : 0); pi.push(0.4);
  }
  const [L, U] = activeCs(f, y, xi, pi, 0.05);
  assert.ok(U - L < 0.45, `PPI width ${ (U - L).toFixed(3) } should beat a ~0.5-wide 40-probe binomial`);
  assert.ok(L <= 0.30 && 0.30 <= U, 'covers the truth q=0.30');
});
