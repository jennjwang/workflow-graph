// Integration test: 4 accountant personas → real background interview →
// model extraction → aggregation-ready records.
//
//   node --env-file=.env scripts/integ_accountants.mjs [N]
//
// Reuses runInterview() (drives the real /api/evaluate-answer endpoint, exactly
// like the live app) and /api/extract-interview-tasks (gpt-4o, temp 0) — the
// live extraction path. Writes:
//   - a per-persona dump (transcript + extracted tasks) for inspection
//   - swe_clean-style records [{task, pids}] consumed by final/aggregation
//
// Output dir is fixed to the task_aggregation scratchpad so nothing lands in
// either repo's tracked tree.

import { runInterview } from "./sim_interview.mjs";
import { writeFileSync, mkdirSync } from "node:fs";

const API = process.env.SIM_API || "http://localhost:3001";
const OUT_DIR =
  process.env.INTEG_OUT ||
  "/private/tmp/claude-501/-Users-jenniferwang-PhD-task-aggregation/fa7be22a-2d63-4072-8dc0-68f39d404732/scratchpad/integ_accountants";
const N = Number(process.argv[2] || 4);

// Four DISTINCT accountant sub-roles so aggregation has both overlap (the shared
// core of accounting work) and divergence (role-specific tasks) to resolve.
export const PERSONAS = [
  {
    name: "Staff accountant (month-end close)",
    pid: "acc00000000000000000001",
    brief:
      "You are a staff accountant at a mid-size manufacturing company, 3 years in. Your work is routine and structured: bank and account reconciliations, posting journal entries, accruals, running the month-end close, and preparing internal financial statements. You answer matter-of-factly and briefly.",
  },
  {
    name: "Tax accountant (public firm)",
    pid: "acc00000000000000000002",
    brief:
      "You are a tax accountant at a public CPA firm, 5 years in. You prepare and review individual and corporate tax returns, research tax code questions, handle quarterly estimated payments, respond to IRS notices, and meet with clients about tax planning. You answer plainly and don't over-explain.",
  },
  {
    name: "External auditor (senior)",
    pid: "acc00000000000000000003",
    brief:
      "You are a senior external auditor at an accounting firm, 4 years in. You plan and execute financial statement audits: testing internal controls, sampling transactions, confirming balances with third parties, documenting workpapers, and drafting audit findings for the manager. You are precise but fairly terse.",
  },
  {
    name: "Management/cost accountant",
    pid: "acc00000000000000000004",
    brief:
      "You are a management (cost) accountant at a consumer-goods company, 6 years in. Your work is analytical: building budgets and forecasts, variance analysis, product costing, preparing management reports and dashboards, and partnering with department heads on spending. You answer concretely but briefly.",
  },
];

async function extract(backgroundTranscript, jobTitle) {
  const res = await fetch(`${API}/api/extract-interview-tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ backgroundTranscript, userProfile: { jobTitle } }),
  });
  if (!res.ok) throw new Error(`extract ${res.status}: ${await res.text()}`);
  return (await res.json()).tasks ?? [];
}

mkdirSync(OUT_DIR, { recursive: true });

const records = []; // {task, pids}
const dump = []; // per-persona detail

for (const persona of PERSONAS.slice(0, N)) {
  process.stdout.write(`\n▶ ${persona.name} … interviewing`);
  const { turns, answersByField, history } = await runInterview(persona, { quiet: true });
  process.stdout.write(" … extracting");
  const tasks = await extract(turns, answersByField.jobTitle);
  process.stdout.write(` … ${tasks.length} tasks\n`);

  for (const t of tasks) records.push({ task: t, pids: persona.pid });
  dump.push({
    name: persona.name,
    pid: persona.pid,
    jobTitle: answersByField.jobTitle,
    transcript: history,
    extractedTasks: tasks,
  });
}

writeFileSync(`${OUT_DIR}/records.json`, JSON.stringify(records, null, 2));
writeFileSync(`${OUT_DIR}/personas_dump.json`, JSON.stringify(dump, null, 2));

console.log(`\n${"═".repeat(70)}`);
console.log(`  ${dump.length} personas · ${records.length} task records`);
console.log(`${"═".repeat(70)}`);
for (const p of dump) {
  console.log(`\n  ${p.name}  (${p.extractedTasks.length} tasks)`);
  for (const t of p.extractedTasks) console.log(`    · ${t}`);
}
console.log(`\n→ ${OUT_DIR}/records.json`);
console.log(`→ ${OUT_DIR}/personas_dump.json`);
