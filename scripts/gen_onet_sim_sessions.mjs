// Generate SIMULATED accountant sessions in onet's schema, for onet/tests/fixtures/.
//
//   node --env-file=.env scripts/gen_onet_sim_sessions.mjs [N]   (default 6)
//
// Drives the live sim end-to-end (real WG server on :3001 + OpenAI): an LLM persona is
// interviewed via /api/evaluate-answer, tasks are extracted (/api/extract-interview-tasks)
// and generated (/api/generate-tasks-from-interview), then each persona is assembled into
// an onet-schema session JSON (selectedTasks + taskItems + occupationSelection + transcript)
// and written to onet/tests/fixtures/ for the pipeline's real-API test to process.
//
// Sim caveat: no participant edits/additions, so every task is status="confirmed" and all
// share the accountant SOC — these exercise onet's atomize + dedup, not the added/edited
// normalize path.

import { runInterview } from "./sim_interview.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

const API = process.env.SIM_API || "http://localhost:3001";
const OUT_DIR = process.env.ONET_FIXTURES || "/Users/jenniferwang/PhD/onet/tests/fixtures";
const COUNT = Number(process.env.SIM_COUNT || 20);
const N = Number(process.argv[2] || 6);
const SOC = { selectedCode: "13-2011.00", selectedTitle: "Accountants and Auditors" };

// Six distinct accountant sub-roles — shared accounting core + role-specific divergence.
const PERSONAS = [
  { name: "Staff accountant (month-end close)", brief:
    "You are a staff accountant at a mid-size manufacturing company, 3 years in. Routine, structured work: bank and account reconciliations, posting journal entries, accruals, running the month-end close, and preparing internal financial statements. Answer matter-of-factly and briefly." },
  { name: "Tax accountant (public firm)", brief:
    "You are a tax accountant at a public CPA firm, 5 years in. You prepare and review individual and corporate tax returns, research tax code questions, handle quarterly estimated payments, respond to IRS notices, and meet with clients about tax planning. Answer plainly, don't over-explain." },
  { name: "External auditor (senior)", brief:
    "You are a senior external auditor at an accounting firm, 4 years in. You plan and execute financial statement audits: testing internal controls, sampling transactions, confirming balances with third parties, documenting workpapers, and drafting audit findings for the manager. Precise but fairly terse." },
  { name: "Management cost accountant", brief:
    "You are a management (cost) accountant at a consumer-goods company, 6 years in. Analytical work: building budgets and forecasts, variance analysis, product costing, preparing management reports and dashboards, and partnering with department heads on spending. Concrete but brief." },
  { name: "Accounts payable specialist", brief:
    "You are an accounts payable specialist at a regional retailer, 4 years in. You process vendor invoices, match purchase orders and receipts, run payment batches, reconcile vendor statements, resolve billing discrepancies, and manage expense reports. Practical and to the point." },
  { name: "Nonprofit fund accountant", brief:
    "You are a fund accountant at a nonprofit, 5 years in. You track restricted and unrestricted funds, allocate expenses across grants, prepare grant financial reports for funders, monitor budget-to-actual by program, and support the annual audit. Careful and plain-spoken." },
];

async function extract(backgroundTranscript, jobTitle) {
  const res = await fetch(`${API}/api/extract-interview-tasks`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ backgroundTranscript, userProfile: { jobTitle } }),
  });
  if (!res.ok) throw new Error(`extract ${res.status}: ${await res.text()}`);
  return (await res.json()).tasks ?? [];
}

async function generate(userProfile, interviewTasks) {
  const res = await fetch(`${API}/api/generate-tasks-from-interview`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...userProfile, interviewTasks, count: COUNT }),
  });
  if (!res.ok) throw new Error(`generate ${res.status}: ${await res.text()}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const tasks = []; // { name, source: "interview" | "gap" }
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const p of parts) {
      const d = p.split("\n").find((l) => l.startsWith("data: "));
      if (!d) continue;
      try {
        const o = JSON.parse(d.slice(6));
        if (o.name) tasks.push({ name: o.name, source: o.source ?? "interview" });
      } catch {}
    }
  }
  return tasks;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

// Fixtures are grouped by occupation: onet/tests/fixtures/<occupation-slug>/.
// Full title slug (no length cap — slug()'s 40-char truncation is only for filenames).
const occSlug = SOC.selectedTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const OCC_DIR = `${OUT_DIR}/${occSlug}`;
mkdirSync(OCC_DIR, { recursive: true });

let i = 0;
for (const persona of PERSONAS.slice(0, N)) {
  i++;
  process.stdout.write(`\n▶ ${persona.name} … interview`);
  const { turns, answersByField } = await runInterview(persona, { quiet: true });
  const userProfile = {
    jobTitle: answersByField.jobTitle || persona.name,
    responsibilities: answersByField.responsibilities || "",
    typicalWeek: answersByField.typicalWeek || "",
  };
  process.stdout.write(" … extract");
  const extracted = await extract(turns, userProfile.jobTitle);
  process.stdout.write(" … generate");
  const generated = await generate(userProfile, extracted);

  const session = {
    sessionId: randomUUID(),
    externalId: null,
    simulated: true,
    persona: persona.name,
    userProfile,
    backgroundTranscript: turns,
    interviewExtractedTasks: extracted,
    taskItems: generated.map((t) => ({
      name: t.name, originalName: t.name, source: t.source, status: "confirmed",
    })),
    selectedTasks: generated.map((t) => t.name),
    occupationSelection: SOC,
  };
  const file = `sim-accountant-${String(i).padStart(2, "0")}-${slug(persona.name)}.json`;
  writeFileSync(`${OCC_DIR}/${file}`, JSON.stringify(session, null, 2));
  process.stdout.write(` … ${session.selectedTasks.length} tasks → ${file}\n`);
}

console.log(`\nDone: ${Math.min(N, PERSONAS.length)} simulated accountant sessions → ${OCC_DIR}`);
