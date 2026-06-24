// Win-rate scoring. Across all held-out incumbent judgments of matched pairs,
// what share preferred OUR statement over the O*NET statement? Forced A-vs-B, so
// every judgment counts. Wilson 95% interval.
//
//   win_rate = (judgments preferring ours) / (all judgments)
//
// Usage: node validation/winrate.mjs
import { loadWinrateResponses } from './lib/io.mjs';
import { wilsonCI } from './lib/stats.mjs';

function fmtPct(x) {
  return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '—';
}

async function main() {
  const responses = await loadWinrateResponses();
  if (responses.length === 0) {
    console.log('No win-rate responses yet (validation/out/responses/winrate/).');
    return;
  }

  // Flatten every judgment, and tally per pair so we can see which pairs ours
  // wins/loses on.
  const perPair = new Map(); // pairId -> { wins, n }
  let wins = 0;
  let n = 0;
  let raters = 0;
  for (const r of responses) {
    if (!Array.isArray(r.judgments)) continue;
    raters++;
    for (const j of r.judgments) {
      n++;
      if (j.oursWon) wins++;
      const p = perPair.get(j.pairId) || { wins: 0, n: 0 };
      p.n++;
      if (j.oursWon) p.wins++;
      perPair.set(j.pairId, p);
    }
  }

  const ci = wilsonCI(wins, n);
  console.log(`Win rate (ours vs onet) — ${raters} raters, ${n} judgments`);
  console.log('');
  console.log(`  ours preferred: ${wins}/${n} = ${fmtPct(ci.p)}`);
  console.log(`  95% CI (Wilson): [${fmtPct(ci.lo)}, ${fmtPct(ci.hi)}]`);
  console.log('');
  console.log('Per-pair (ours win share):');
  const rows = [...perPair.entries()].sort((a, b) => b[1].wins / b[1].n - a[1].wins / a[1].n);
  for (const [pairId, p] of rows) {
    console.log(`  ${pairId.padEnd(14)} ${String(p.wins).padStart(3)}/${String(p.n).padEnd(3)}  ${fmtPct(p.wins / p.n)}`);
  }
  return { wins, n, p: ci.p, lo: ci.lo, hi: ci.hi };
}

main().catch((err) => { console.error(err); process.exit(1); });
