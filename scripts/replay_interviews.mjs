// Replay past interview sessions through the CURRENT task pipeline:
//   /api/extract-interview-tasks  →  /api/generate-tasks-from-interview
// Prints the normalized, O*NET-style task list (least-confident first) per session.
//
//   node scripts/replay_interviews.mjs
import { readFileSync } from "node:fs";

const API = process.env.SIM_API || "http://localhost:3001";
const DATA = "/Users/jenniferwang/PhD/task_aggregation/data";
const FILES = [
  "009e8d35-2fdd-4d69-8700-feeb975e7118.json",
  "aae31d8b-5402-4051-9491-4c43d2c3f9fd.json",
];

async function extract(backgroundTranscript, userProfile) {
  const r = await fetch(`${API}/api/extract-interview-tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ backgroundTranscript, userProfile }),
  });
  const j = await r.json();
  return j.tasks ?? j;
}

async function generate(profile, interviewTasks) {
  const res = await fetch(`${API}/api/generate-tasks-from-interview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jobTitle: profile.jobTitle,
      responsibilities: profile.responsibilities,
      typicalWeek: profile.typicalWeek,
      aiUsage: profile.aiUsage,
      interviewTasks,
      count: 15,
    }),
  });
  const text = await res.text();
  const tasks = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^data: (.+)$/);
    if (!m) continue;
    try {
      const o = JSON.parse(m[1]);
      if (o.name) tasks.push(o.name);
    } catch {}
  }
  return tasks;
}

for (const f of FILES) {
  const d = JSON.parse(readFileSync(`${DATA}/${f}`, "utf8"));
  const p = d.userProfile;
  console.log("\n" + "═".repeat(78));
  console.log("  " + (p.jobTitle || "?").replace(/\s+/g, " ").trim());
  console.log("═".repeat(78));
  console.log("  responsibilities:", (p.responsibilities || "").replace(/\s+/g, " ").slice(0, 140));
  console.log("  typical week    :", (p.typicalWeek || "").replace(/\s+/g, " ").slice(0, 140));

  const extracted = await extract(d.backgroundTranscript, p);
  console.log(`\n  EXTRACTED (${extracted.length}):`);
  extracted.forEach((t) => console.log("    ·", t));

  const tasks = await generate(p, extracted);
  console.log(`\n  GENERATED — normalized, O*NET style, least-confident first (${tasks.length}):`);
  tasks.forEach((t, i) => console.log(`    ${String(i + 1).padStart(2)}. ${t}`));
}
console.log();
