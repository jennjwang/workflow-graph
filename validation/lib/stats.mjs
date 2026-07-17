// Analytical confidence intervals. No resampling.

// Two-sided 95% t critical values for small df; falls back to z=1.96 for large
// df. Enough granularity for the held-out-incumbent sample sizes we expect.
const T95 = {
  1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365,
  8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145,
  15: 2.131, 16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086, 21: 2.080,
  22: 2.074, 23: 2.069, 24: 2.064, 25: 2.060, 26: 2.056, 27: 2.052, 28: 2.048,
  29: 2.045, 30: 2.042,
};
function t95(df) {
  if (df <= 0) return NaN;
  if (T95[df] != null) return T95[df];
  if (df <= 40) return 2.021;
  if (df <= 60) return 2.000;
  if (df <= 120) return 1.980;
  return 1.96;
}

// Mean of a continuous sample with a t-based 95% CI on the mean.
export function meanCI(values) {
  const xs = values.filter((v) => Number.isFinite(v));
  const n = xs.length;
  if (n === 0) return { n: 0, mean: NaN, lo: NaN, hi: NaN, se: NaN };
  const mean = xs.reduce((s, v) => s + v, 0) / n;
  if (n === 1) return { n, mean, lo: NaN, hi: NaN, se: NaN };
  const variance = xs.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  const se = Math.sqrt(variance / n);
  const m = t95(n - 1) * se;
  return { n, mean, lo: mean - m, hi: mean + m, se };
}

// Wilson score 95% interval for a binomial proportion (used by the quality and
// task-quality rubric metrics).
export function wilsonCI(successes, total) {
  if (total === 0) return { n: 0, p: NaN, lo: NaN, hi: NaN };
  const z = 1.96;
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const center = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  return { n: total, p, lo: (center - margin) / denom, hi: (center + margin) / denom };
}
