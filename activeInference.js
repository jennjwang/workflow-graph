// activeInference.js — PORT of final/active_learning/batch_active.py (PPI active estimator + betting CS).
// Pure numeric, NO deps (so it loads in tests without the OpenAI/DB import that taskBank.js eagerly does).
//
// The non-mention probe stratum's doer-fraction q is estimated from the PPI influence terms
//   g_i = f_i + (ξ_i/π_i)(Y_i − f_i)
// — f is a free baseline for EVERY non-mentioner, probes add the IPW correction (unbiased for any f; f only
// reduces variance). Its anytime-valid confidence sequence is the hedged-capital BETTING CS, candidates
// gridded directly in θ∈[0,1]. Validated to match batch_active.py to ±2e-3 (grid resolution 1e-3). Keep in
// sync with batch_active.py.

const logaddexp = (a, b) => {
  if (a === -Infinity) return b;
  if (b === -Infinity) return a;
  const m = Math.max(a, b);
  return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
};

// g_i = f_i + (ξ_i/π_i)(Y_i − f_i); unprobed (ξ=0) ⇒ g_i = f_i (the free baseline).
export function influenceTerms(f, y, xi, pi) {
  const g = new Array(f.length);
  for (let i = 0; i < f.length; i++)
    g[i] = f[i] + (xi[i] > 0 ? (y[i] - f[i]) * xi[i] / Math.max(pi[i], 1e-12) : 0);
  return g;
}

// q̂ = mean of the influence terms (the active estimator).
export function activeEstimate(f, y, xi, pi) {
  const g = influenceTerms(f, y, xi, pi);
  if (g.length === 0) return 0;
  let s = 0; for (const v of g) s += v;
  return s / g.length;
}

// Hedged-capital betting CS for E[g]=θ∈[0,1]: for each candidate θ, K±(θ)=Π(1±λ_t(g_t−θ)) with predictable
// aGRAPA λ (running mean/var of g), clipped so every factor stays positive. CS = {θ : ½(K⁺+K⁻) < 1/α}
// (Ville). Returns [L,U]. Mirrors batch_active._betting_cs (gridded in θ, processed in arrival order).
export function bettingCs(g, gLo, gHi, alpha, grid = 1001) {
  if (g.length === 0) return [0, 1];
  const th = new Array(grid), cap = new Array(grid);
  const logKp = new Array(grid).fill(0), logKm = new Array(grid).fill(0);
  for (let j = 0; j < grid; j++) {
    th[j] = j / (grid - 1);
    cap[j] = 0.9 / Math.max(Math.max(gHi - th[j], th[j] - gLo), 1e-9);   // keep 1 ± λ(g−θ) > 0
  }
  let s = 0, s2 = 0, t = 0;
  const var0 = (gHi - gLo) ** 2 / 12 + 1e-6;
  const thr = Math.log(1 / alpha);
  for (const gt of g) {
    const mu = t === 0 ? 0.5 : s / t;
    const varr = t === 0 ? var0 : Math.max(1e-8, s2 / t - mu * mu);
    for (let j = 0; j < grid; j++) {
      let lam = Math.abs(mu - th[j]) / (varr + 1e-9);
      if (lam > cap[j]) lam = cap[j];                    // predictable, clipped (λ ≥ 0 already)
      const d = gt - th[j];
      logKp[j] += Math.log1p(lam * d);
      logKm[j] += Math.log1p(-lam * d);
    }
    s += gt; s2 += gt * gt; t += 1;
  }
  const ln2 = Math.log(2);
  let lo = Infinity, hi = -Infinity, anyKeep = false, argmin = 0, minLogK = Infinity;
  for (let j = 0; j < grid; j++) {
    const logK = logaddexp(logKp[j], logKm[j]) - ln2;
    if (logK < minLogK) { minLogK = logK; argmin = j; }
    if (logK < thr) { anyKeep = true; if (th[j] < lo) lo = th[j]; if (th[j] > hi) hi = th[j]; }
  }
  return anyKeep ? [lo, hi] : [th[argmin], th[argmin]];
}

// Anytime-valid [L,U] for q from the influence terms (betting CS, gridded in θ). alpha = 1 − c.
export function activeCs(f, y, xi, pi, alpha) {
  if (f.length === 0) return [0, 1];
  const g = influenceTerms(f, y, xi, pi);
  let pmin = Infinity; for (const p of pi) if (p < pmin) pmin = p;
  pmin = Math.max(pmin, 1e-12);
  let gmin = Infinity, gmax = -Infinity; for (const v of g) { if (v < gmin) gmin = v; if (v > gmax) gmax = v; }
  const gLo = Math.min(1 - 1 / pmin, gmin);              // range for the λ-positivity cap
  const gHi = Math.max(1 / pmin, gmax);
  return bettingCs(g, gLo, gHi, alpha);
}
