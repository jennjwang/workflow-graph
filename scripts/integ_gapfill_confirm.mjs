// Mode 2: for each accountant persona, get the gap-fill SUGGESTIONS, then let the
// persona-LLM confirm/reject each (in character, as a real participant would in the
// Phase-2 grid). Emit combined records = mentioned extractions + CONFIRMED gap-fills.
//
//   node --env-file=.env scripts/integ_gapfill_confirm.mjs
//
// Reads the earlier personas dump (mentioned tasks + jobTitle). Hits the real
// /api/generate-tasks-from-interview for gap-fill, then a persona-LLM accept/reject.

import OpenAI from "openai";
import { readFileSync, writeFileSync } from "node:fs";

const API = process.env.SIM_API || "http://localhost:3001";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const DIR =
  "/private/tmp/claude-501/-Users-jenniferwang-PhD-task-aggregation/fa7be22a-2d63-4072-8dc0-68f39d404732/scratchpad/integ_accountants";

// pid → persona brief, so the confirmation stays in character. Matches integ_accountants.mjs.
const BRIEF = {
  acc00000000000000000001:
    "You are a staff accountant at a mid-size manufacturing company, 3 years in. Routine, structured work: reconciliations, journal entries, accruals, month-end close, internal financial statements.",
  acc00000000000000000002:
    "You are a tax accountant at a public CPA firm, 5 years in. You prepare/review individual and corporate tax returns, research tax code, handle quarterly estimated payments, respond to IRS notices, and meet with clients about tax planning.",
  acc00000000000000000003:
    "You are a senior external auditor at an accounting firm, 4 years in. You plan/execute financial statement audits: testing controls, sampling, confirming balances, documenting workpapers, drafting findings for the manager.",
  acc00000000000000000004:
    "You are a management (cost) accountant at a consumer-goods company, 6 years in. Analytical work: budgets/forecasts, variance analysis, product costing, management reports/dashboards, partnering with department heads on spending.",
};

async function gapFills(jobTitle, interviewTasks) {
  const res = await fetch(`${API}/api/generate-tasks-from-interview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobTitle, interviewTasks, count: 20 }),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const gaps = [];
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
        if (o.name && o.source === "gap") gaps.push(o.name);
      } catch {}
    }
  }
  return gaps;
}

// Persona confirms which suggested tasks they actually do — like ticking boxes in the grid.
async function confirm(brief, suggestions) {
  if (!suggestions.length) return [];
  const res = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.3,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          `${brief}\n\nYou are reviewing a checklist of tasks an assistant guessed you might do. ` +
          `For each, decide honestly whether it is genuinely part of YOUR paid work. Accept the ones ` +
          `that fit your real role; reject any that don't apply to you (wrong specialization, not your ` +
          `responsibility, or something you simply don't do). Be realistic — a real person accepts most ` +
          `reasonable guesses but rejects the ones that miss.\n\n` +
          `Return JSON: {"decisions":[{"i":<index>,"accept":<true|false>}]} for every item.`,
      },
      {
        role: "user",
        content: suggestions.map((t, i) => `${i}. ${t}`).join("\n"),
      },
    ],
  });
  const parsed = JSON.parse(res.choices[0].message.content);
  const accepted = [];
  for (const d of parsed.decisions ?? []) if (d.accept) accepted.push(suggestions[d.i]);
  return accepted;
}

const dump = JSON.parse(readFileSync(`${DIR}/personas_dump.json`, "utf8"));
const records = []; // {task, pids, source}
const report = [];

for (const p of dump) {
  const gaps = await gapFills(p.jobTitle, p.extractedTasks);
  const accepted = await confirm(BRIEF[p.pid], gaps);
  const rejected = gaps.filter((g) => !accepted.includes(g));

  for (const t of p.extractedTasks) records.push({ task: t, pids: p.pid, source: "mentioned" });
  for (const t of accepted) records.push({ task: t, pids: p.pid, source: "gap_confirmed" });

  report.push({ name: p.name, mentioned: p.extractedTasks.length, suggested: gaps.length, accepted, rejected });
  console.log(`\n${"═".repeat(72)}\n  ${p.name}`);
  console.log(`  mentioned=${p.extractedTasks.length} · gap suggested=${gaps.length} · CONFIRMED=${accepted.length} · rejected=${rejected.length}`);
  for (const t of accepted) console.log(`    ✔ ${t}`);
  for (const t of rejected) console.log(`    ✗ ${t}`);
}

// Records for the pipeline drop the source tag (aggregation just wants {task, pids}).
writeFileSync(`${DIR}/records_mode2.json`, JSON.stringify(records.map(({ task, pids }) => ({ task, pids })), null, 2));
writeFileSync(`${DIR}/gapfill_report.json`, JSON.stringify(report, null, 2));
console.log(`\n${"═".repeat(72)}`);
console.log(`  total records (mentioned + confirmed gaps): ${records.length}`);
console.log(`  → ${DIR}/records_mode2.json`);
