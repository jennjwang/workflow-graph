// Coverage scoring. Reads held-out incumbent allocation responses and reports,
// per method, the mean covered time-share with a t-interval.
//
//   covered_share = Σ(hours on inventory statements) / total weekly hours
//
// Usage: node validation/coverage.mjs
import { loadCoverageResponses } from './lib/io.mjs';
import { meanCI } from './lib/stats.mjs';

function coveredShare(r) {
  const total = Number(r.totalHours);
  if (!Number.isFinite(total) || total <= 0) return null;
  const covered = (r.allocations || [])
    .filter((a) => a.source === 'inventory')
    .reduce((s, a) => s + (Number(a.hours) || 0), 0);
  return Math.min(1, covered / total);
}

function fmtPct(x) {
  return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '—';
}

async function main() {
  const responses = await loadCoverageResponses();
  if (responses.length === 0) {
    console.log('No coverage responses yet (validation/out/responses/coverage/).');
    return;
  }

  const byMethod = new Map();
  let skipped = 0;
  for (const r of responses) {
    const share = coveredShare(r);
    if (share == null) { skipped++; continue; }
    const key = r.method || 'unknown';
    if (!byMethod.has(key)) byMethod.set(key, []);
    byMethod.get(key).push(share);
  }

  console.log(`Coverage — ${responses.length} responses` +
    (skipped ? ` (${skipped} skipped: no/zero total hours)` : ''));
  console.log('');
  console.log('method        n     mean      95% CI');
  console.log('------------  ---  --------  ------------------');
  const rows = [];
  for (const [method, shares] of [...byMethod].sort()) {
    const ci = meanCI(shares);
    const ciStr = Number.isFinite(ci.lo) ? `[${fmtPct(ci.lo)}, ${fmtPct(ci.hi)}]` : '(n<2)';
    console.log(
      `${method.padEnd(12)}  ${String(ci.n).padStart(3)}  ${fmtPct(ci.mean).padStart(7)}  ${ciStr}`,
    );
    rows.push({ method, n: ci.n, mean: ci.mean, lo: ci.lo, hi: ci.hi });
  }
  return rows;
}

main().catch((err) => { console.error(err); process.exit(1); });
