// End-to-end: simulated interview → extract tasks → generate the task list,
// labeling each generated task as interview-normalized vs gap-fill.
//
//   node --env-file=.env scripts/sim_pipeline.mjs
//   node --env-file=.env scripts/sim_pipeline.mjs "Construction electrician"
//
// Reuses the interview simulator (scripts/sim_interview.mjs) for the conversation,
// then hits the real /api/extract-interview-tasks and
// /api/generate-tasks-from-interview endpoints — the live pipeline.

import { PERSONAS, runInterview } from "./sim_interview.mjs";

const API = process.env.SIM_API || "http://localhost:3001";
const COUNT = Number(process.env.SIM_COUNT || 20); // tracks the picker's MAX_TASKS
const only = process.argv[2];

async function extract(backgroundTranscript, userProfile) {
  const res = await fetch(`${API}/api/extract-interview-tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ backgroundTranscript, userProfile }),
  });
  return (await res.json()).tasks ?? [];
}

async function generate(userProfile, interviewTasks) {
  const res = await fetch(`${API}/api/generate-tasks-from-interview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...userProfile, interviewTasks, count: COUNT }),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const tasks = []; // { name, source: "interview" | "gap" } — tagged by the server
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

for (const persona of PERSONAS) {
  if (only && persona.name !== only) continue;

  const { turns, answersByField } = await runInterview(persona, { quiet: true });
  const userProfile = {
    jobTitle: answersByField.jobTitle,
    responsibilities: answersByField.responsibilities,
    typicalWeek: answersByField.typicalWeek,
  };

  const extracted = await extract(turns, userProfile);
  const generated = await generate(userProfile, extracted); // server-tagged source
  const norm = generated.filter((t) => t.source === "interview");
  const gaps = generated.filter((t) => t.source === "gap");

  console.log(`\n${"═".repeat(76)}\n  ${persona.name}\n${"═".repeat(76)}`);
  console.log(`\n  EXTRACTED FROM INTERVIEW (${extracted.length}):`);
  extracted.forEach((t) => console.log(`    · ${t}`));
  const pct = generated.length ? Math.round((gaps.length / generated.length) * 100) : 0;
  console.log(`\n  GENERATED (${generated.length}): ${norm.length} normalized + ${gaps.length} gap-fill (${pct}% gap)`);
  console.log(`\n  — normalized from interview —`);
  norm.forEach((t) => console.log(`    ✦ ${t.name}`));
  console.log(`\n  — gap-fill (not mentioned) —`);
  if (gaps.length === 0) console.log("    (none)");
  gaps.forEach((t) => console.log(`    + ${t.name}`));
}
console.log();
