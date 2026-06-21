// Regression tests for the stratified inventory decision in taskBank.js — specifically the probGe
// cancellation bug: the old `1 − Σ_{j≥a}` form lost all precision when θ > the data mean (Σ≈1),
// leaving a ±1e-13 float residual that logEprocess amplified into a spurious e-value, inverting
// eprocessCs's lower bound and mis-deciding low-mention-rate / high-N tasks as IN. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
// taskBank.js eagerly constructs an OpenAI client at import; stub the key so these PURE-function tests
// (no network, no DB) load it under `npm test` without real credentials, then dynamic-import.
process.env.OPENAI_API_KEY ||= 'sk-test-stub';
const { probGe, eprocessCs, decideStratified } = await import('../taskBank.js');

test('probGe is monotone ↓ in θ and ~0 above the mean (no 1−Σ cancellation)', () => {
  const ths = [0.02, 0.05, 0.3, 0.5, 0.7, 0.9];
  const vals = ths.map(t => probGe(6, 294, t));               // Beta(7,295), mean ≈ 0.02
  for (let i = 1; i < vals.length; i++)
    assert.ok(vals[i] <= vals[i - 1] + 1e-12, `monotone fails at θ=${ths[i]}: ${vals[i]} > ${vals[i - 1]}`);
  assert.ok(vals.every(v => v >= -1e-15), 'no negative residual');
  assert.ok(vals[3] < 1e-30, `P(prev≥0.5) for 6/294 should be ≈0, got ${vals[3]}`);
});

test('eprocessCs is not inverted for low-mean / high-n (L ≤ U)', () => {
  const [L, U] = eprocessCs(6, 294);
  assert.ok(L <= U, `inverted CS: L=${L} > U=${U}`);
  assert.ok(U < 0.1, `upper bound should sit near the 0.02 mean, got ${U}`);
});

test('decideStratified does not over-include low-prevalence tasks (the bug)', () => {
  assert.equal(decideStratified(300, 6, 60, 4), 'OUT');       // 2% mentions + mostly-deny probes → OUT
  assert.equal(decideStratified(100, 2, 100, 1), 'OUT');      // ~3% prevalence → OUT (prod returned IN)
  assert.equal(decideStratified(300, 250, 0, 0), 'IN');       // 83% mention floor still promotes → IN
});

test('probGe survives large n without overflow', () => {
  assert.ok(Math.abs(probGe(2000, 2000, 0.5) - 0.5) < 0.02);  // symmetric → ~0.5
  assert.ok(probGe(50, 3950, 0.67) < 1e-30);                  // huge n, θ ≫ mean → ~0
});
