#!/usr/bin/env node
// Operator CLI: drain the UNCERTAIN-tier merge queue (pending_merges) for an occupation, in a safe window
// (between collection waves — these merges retire tasks; doing it while serving risks straggler answers
// landing on retired ids). See INCREMENTAL_CLOSURE.md §3c. Strong-tier bridges already applied online in
// drainSession; this only handles the ones that were too uncertain to auto-apply.
//
//   node --env-file=.env applyMergesCli.mjs <occupation> [--apply] [--gate]
//
// Default is DRY-RUN (list the queued proposals). --apply executes them via mergeTasks. --gate re-applies
// the agreement gate at apply time (signal may have accrued since the proposal was queued).
import { applyPendingMerges, pool } from './taskBank.js';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--')).map(a => a.slice(2)));
const occ = argv.find(a => !a.startsWith('--'));
if (!occ) {
  console.error('usage: node --env-file=.env applyMergesCli.mjs <occupation> [--apply] [--gate]');
  process.exit(2);
}

let code = 0;
try {
  const dryRun = !flags.has('apply');
  const res = await applyPendingMerges(occ, { dryRun, gate: flags.has('gate') });
  console.log(`${dryRun ? 'DRY-RUN' : 'APPLY'} ${occ}: ${res.length} pending merge(s)`);
  for (const r of res)
    console.log(`  ${r.drop} → ${r.keep}  ${r.action || r.status}${r.reason ? '  (' + r.reason + ')' : ''}`);
  if (dryRun && res.length) console.log('  (re-run with --apply to execute)');
} catch (e) { console.error('ERROR:', e.message); code = 3; }
finally { await pool.end(); }
process.exit(code);
