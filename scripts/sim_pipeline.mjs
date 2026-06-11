// End-to-end: simulated interview → extract tasks → generate the task list,
// labeling each generated task as interview-normalized vs gap-fill.
//
//   node --env-file=.env scripts/sim_pipeline.mjs
//   node --env-file=.env scripts/sim_pipeline.mjs "Construction electrician"
//
// Reuses the interview simulator (scripts/sim_interview.mjs) for the conversation,
// then hits the real /api/extract-interview-tasks and
// /api/generate-tasks-from-interview endpoints — the live pipeline.

import OpenAI from "openai";
import { PERSONAS, runInterview } from "./sim_interview.mjs";

const API = process.env.SIM_API || "http://localhost:3001";
const COUNT = Number(process.env.SIM_COUNT || 10); // tracks the picker's MAX_TASKS
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
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
          if (o.name) tasks.push(o.name);
        } catch {}
      }
    }
  }
  return tasks;
}

async function classify(mentioned, generated) {
  const r = await client.chat.completions.create({
    model: "gpt-4o",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "user",
        content: `MENTIONED tasks (extracted from the interview):\n${mentioned.map((t) => "- " + t).join("\n")}\n\nGENERATED tasks:\n${generated.map((t, i) => `${i + 1}. ${t}`).join("\n")}\n\nFor each generated task, decide if it primarily COVERS one or more of the mentioned tasks (source "interview") or is a GAP-FILL not present in the mentioned set (source "gapfill"). Return JSON: {"items":[{"task":"...","source":"interview"|"gapfill","covers":["mentioned tasks it absorbs"]}]}`,
      },
    ],
  });
  return JSON.parse(r.choices[0].message.content).items;
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
  const generated = await generate(userProfile, extracted);
  const labeled = await classify(extracted, generated);

  console.log(`\n${"═".repeat(76)}\n  ${persona.name}\n${"═".repeat(76)}`);
  console.log(`\n  EXTRACTED FROM INTERVIEW (${extracted.length}):`);
  extracted.forEach((t) => console.log(`    · ${t}`));
  console.log(`\n  GENERATED TASKS (${generated.length}):`);
  console.log(`\n  — normalized from interview —`);
  labeled
    .filter((i) => i.source === "interview")
    .forEach((i) =>
      console.log(
        `    ✦ ${i.task}${i.covers?.length ? `   ⟵ ${i.covers.join("; ")}` : ""}`,
      ),
    );
  const gaps = labeled.filter((i) => i.source === "gapfill");
  console.log(`\n  — gap-fill (not mentioned) —`);
  if (gaps.length === 0) console.log("    (none)");
  gaps.forEach((i) => console.log(`    + ${i.task}`));
}
console.log();
