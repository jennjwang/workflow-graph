// Dump SIMULATED interview transcripts (scripted vs gap-driven planner) to a .txt.
// For each persona, runs both interviewers against the same persona simulator and
// writes the full Q/A of each. Read-only.
//
//   node --env-file=.env scripts/show_transcript.mjs                 # 4 personas
//   node --env-file=.env scripts/show_transcript.mjs 6               # first 6
//   node --env-file=.env scripts/show_transcript.mjs "Terse engineer"
//
// Output: sim_transcripts.txt (gitignored). Requires the dev server on :3001.
import { writeFileSync } from "node:fs";
import { PERSONAS, runInterview } from "./sim_interview.mjs";
import { runPlannerV2, runPlannerV3 } from "./planner_ab.mjs";

const arg = process.argv[2];
const selected = !arg
  ? PERSONAS.slice(0, 1)
  : /^\d+$/.test(arg)
    ? PERSONAS.slice(0, Number(arg))
    : PERSONAS.filter((p) => p.name === arg);

if (!selected.length) {
  console.error("persona not found. options:\n  " + PERSONAS.map((p) => p.name).join("\n  "));
  process.exit(1);
}

const out = [];
const w = (s = "") => out.push(s);

function transcript(title, turns) {
  w("─".repeat(80));
  w(`${title}  —  ${turns.length} turns`);
  w("─".repeat(80));
  turns.forEach((t, i) => {
    const tag = t.field ? ` [${t.field}]` : "";
    w(`Q${i + 1}${tag}: ${String(t.question || "").trim()}`);
    if (t.gap) w(`   ↳ targeting gap: ${t.gap}`);
    w(`   A: ${String(t.answer || "").trim()}`);
    w("");
  });
}

for (const persona of selected) {
  w("═".repeat(80));
  w(`PERSONA: ${persona.name}`);
  w(persona.brief);
  w("═".repeat(80));
  w("");
  let baseN = "—";
  if (process.env.PLANNER_ONLY !== "1") {
    const base = await runInterview(persona, { quiet: true });
    transcript("SCRIPTED interview", base.turns);
    baseN = base.turns.length;
  }
  const v2 = await runPlannerV2(persona);
  transcript("PLANNER v2 (heuristic, criteria-gated)", v2.turns);
  const v3 = await runPlannerV3(persona);
  transcript("PLANNER v3 (expected-utility / rollout)", v3.turns);
  w("");
  console.log(`done: ${persona.name}  (scripted ${baseN} / v2 ${v2.turns.length} / v3 ${v3.turns.length} turns)`);
}

const path = new URL("../sim_transcripts.txt", import.meta.url).pathname;
writeFileSync(path, out.join("\n"));
console.log(`\nwrote ${selected.length} persona(s) → ${path}`);
