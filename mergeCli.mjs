#!/usr/bin/env node
// Operator CLI to merge two EXISTING bank tasks (curation cleanup of a harvest false-negative: keep &
// drop turned out equivalent). Relabels drop's responses/generated_responses to keep, folds weight,
// retires drop — under the per-occupation advisory lock. See taskBank.mergeTasks / ACTIVE_LEARNING.md §6b.
//
//   node --env-file=.env mergeCli.mjs <occupation> <keepId> <dropId> [--gate] [--min-overlap N] [--min-agreement F]
//
// The double-probed agreement rate is ALWAYS reported (the behavioral cross-check on the classifier).
// Without --gate the merge proceeds regardless (operator eyeballs the rate); --gate auto-refuses a
// low-agreement merge (≥ min-overlap double-probers and rate < min-agreement). Defaults 3 / 0.7.
import { mergeTasks, pool } from './taskBank.js';

const argv = process.argv.slice(2);
const flags = new Map();
const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const k = argv[i].slice(2);
    const v = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
    flags.set(k, v);
  } else pos.push(argv[i]);
}
const [occupation, keepId, dropId] = pos;
if (!occupation || !keepId || !dropId) {
  console.error('usage: node --env-file=.env mergeCli.mjs <occupation> <keepId> <dropId> [--gate] [--min-overlap N] [--min-agreement F]');
  process.exit(2);
}
const opts = {
  gate: flags.has('gate'),
  minOverlap: flags.has('min-overlap') ? Number(flags.get('min-overlap')) : 3,
  minAgreement: flags.has('min-agreement') ? Number(flags.get('min-agreement')) : 0.7,
};

let code = 0;
try {
  console.log(`merge ${dropId} → ${keepId}  (occupation=${occupation}, gate=${opts.gate})`);
  const res = await mergeTasks(occupation, keepId, dropId, opts);
  const ag = res.agreement || { agree: 0, both: 0, rate: null };
  console.log(`  double-probed agreement: ${ag.agree}/${ag.both}` +
              (ag.rate == null ? '  (no overlap — no behavioral signal)' : `  = ${(ag.rate * 100).toFixed(0)}%`));
  if (res.merged) {
    console.log(`  MERGED — ${dropId} retired; weight folded into ${keepId} = ${res.weight}`);
  } else {
    console.log(`  REFUSED (${res.reason}) — nothing changed` +
                (res.reason === 'low_agreement' ? ` (run without --gate, or lower --min-agreement, to force)` : ''));
    code = 1;
  }
} catch (e) {
  console.error('  ERROR:', e.message);
  code = 3;
} finally {
  await pool.end();
}
process.exit(code);
