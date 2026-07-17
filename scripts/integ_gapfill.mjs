// Show what the gap-fill pass would SUGGEST for each accountant persona —
// tasks inferred from their own answers that they did NOT mention.
//
//   node --env-file=.env scripts/integ_gapfill.mjs
//
// Reads the personas dump from the earlier integ run and hits the real
// /api/generate-tasks-from-interview endpoint, separating source:interview
// (normalized from what they said) from source:gap (inferred, unmentioned).

import { readFileSync } from "node:fs";

const API = process.env.SIM_API || "http://localhost:3001";
const DUMP =
  "/private/tmp/claude-501/-Users-jenniferwang-PhD-task-aggregation/fa7be22a-2d63-4072-8dc0-68f39d404732/scratchpad/integ_accountants/personas_dump.json";

async function generate(jobTitle, interviewTasks) {
  const res = await fetch(`${API}/api/generate-tasks-from-interview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobTitle, interviewTasks, count: 20 }),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const tasks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const p of parts) {
      const d = p.split("\n").find((l) => l.startsWith("data: "));
      if (d) {
        try {
          const o = JSON.parse(d.slice(6));
          if (o.name) tasks.push({ name: o.name, source: o.source ?? "interview" });
        } catch {}
      }
    }
  }
  return tasks;
}

const dump = JSON.parse(readFileSync(DUMP, "utf8"));
for (const p of dump) {
  const gen = await generate(p.jobTitle, p.extractedTasks);
  const norm = gen.filter((t) => t.source === "interview");
  const gap = gen.filter((t) => t.source === "gap");
  console.log(`\n${"═".repeat(72)}\n  ${p.name}`);
  console.log(`  mentioned=${p.extractedTasks.length} · normalized=${norm.length} · GAP-FILL=${gap.length}`);
  console.log(`  — inferred tasks they did NOT mention —`);
  if (!gap.length) console.log("    (none)");
  for (const g of gap) console.log(`    + ${g.name}`);
}
console.log();
