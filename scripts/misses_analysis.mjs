// Misses analysis: which GOLD tasks do the interviews systematically fail to
// surface? Pools missed gold tasks across personas (for the SCRIPTED interview and
// the gap-driven PLANNER), then clusters them by FUNCTIONAL dimension to reveal
// blind-spots — candidate new "spine" topics. Read-only.
//
//   node --env-file=.env scripts/misses_analysis.mjs        # 8 personas
//   node --env-file=.env scripts/misses_analysis.mjs 12
//
// Requires the dev server on :3001.
import OpenAI from "openai";
import { PERSONAS, runInterview } from "./sim_interview.mjs";
import { runPlannerV2 } from "./planner_ab.mjs";

const API = process.env.SIM_API || "http://localhost:3001";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.PLANNER_MODEL || "gpt-4o";
const arg = process.argv[2];
const selected = /^\d+$/.test(arg || "") ? PERSONAS.slice(0, Number(arg)) : PERSONAS.slice(0, 8);
const SKIP_PLANNER = process.env.SKIP_PLANNER === "1"; // scripted-only (cheap A/B of a pass change)

async function goldSet(persona) {
  const r = await client.chat.completions.create({
    model: MODEL, temperature: 0, response_format: { type: "json_object" },
    messages: [
      { role: "system", content: `Given a worker persona, infer their job title and list the GOLD SET of core recurring WORK TASKS a competent person in that exact role does. O*NET style: verb-led, concrete, role-distinctive.

The set MUST be MECE:
- MUTUALLY EXCLUSIVE — no two tasks overlap. CRITICALLY, collapse the SAME activity done for different people/teams/audiences into ONE task (e.g. "coordinate with sales" + "coordinate with partners" + "collaborate with agencies" → ONE "coordinate with internal and external stakeholders"; "report to manager" + "present to senior leadership" → ONE "report on performance to leadership"). Same activity / different audience = ONE task.
- COLLECTIVELY EXHAUSTIVE — covers the whole role.
Aim for ~10-14 DISTINCT activities (fewer if the role is narrow). Return JSON {"jobTitle":"...","gold":["...", ...]}.` },
      { role: "user", content: `Persona: ${persona.brief}` },
    ],
  });
  const j = JSON.parse(r.choices[0].message.content);
  return { jobTitle: j.jobTitle || persona.name, gold: Array.isArray(j.gold) ? j.gold : [] };
}

async function extract(turns, profile) {
  const backgroundTranscript = turns.map((t, i) => ({ field: t.field || "q", question: t.question, answer: t.answer, isFollowUp: !!t.isFollowUp, timestamp: i }));
  const r = await fetch(`${API}/api/extract-interview-tasks`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ backgroundTranscript, userProfile: profile }),
  });
  const j = await r.json();
  return Array.isArray(j.tasks) ? j.tasks : [];
}

// Return the GOLD tasks NOT covered by any elicited task.
async function missingGold(gold, elicited) {
  const r = await client.chat.completions.create({
    model: MODEL, temperature: 0, response_format: { type: "json_object" },
    messages: [
      { role: "system", content: `For each GOLD task, decide if it is COVERED by any ELICITED task (same activity, meaning not wording). Return JSON {"missing":["the GOLD tasks that are NOT covered, verbatim"]}.` },
      { role: "user", content: `GOLD:\n${gold.map((t) => `- ${t}`).join("\n")}\n\nELICITED:\n${elicited.map((t) => `- ${t}`).join("\n") || "(none)"}` },
    ],
  });
  try { const j = JSON.parse(r.choices[0].message.content); return Array.isArray(j.missing) ? j.missing : []; }
  catch { return []; }
}

// Cluster pooled missed tasks (tagged with role) into functional dimensions.
async function clusterMisses(tagged) {
  const r = await client.chat.completions.create({
    model: MODEL, temperature: 0, response_format: { type: "json_object" },
    messages: [
      { role: "system", content: `These are GOLD work-tasks that interviews FAILED to surface, across many roles (each tagged with its role). Cluster them by FUNCTIONAL DIMENSION — the kind of work, abstracted across roles (e.g. troubleshooting/exceptions, review/QA/approval, planning/prioritization, maintenance/upkeep, record-keeping/admin, compliance/safety, training/mentoring, coordination/communication, monitoring/reporting, procurement/resourcing). Return JSON {"categories":[{"name":"...","count":<int>,"examples":["3-4 representative tasks"]}]} sorted by count DESCENDING. Use as few, clear categories as the data warrants.` },
      { role: "user", content: tagged.map((t) => `- [${t.role}] ${t.task}`).join("\n") },
    ],
  });
  try { return JSON.parse(r.choices[0].message.content).categories ?? []; }
  catch { return []; }
}

const missScripted = [], missPlanner = [];
let goldTotal = 0;
for (const persona of selected) {
  const gold = await goldSet(persona);
  goldTotal += gold.gold.length;
  const base = await runInterview(persona, { quiet: true });
  const bt = await extract(base.turns, { jobTitle: gold.jobTitle });
  const mb = await missingGold(gold.gold, bt);
  mb.forEach((task) => missScripted.push({ role: gold.jobTitle, task }));
  let mp = [];
  if (!SKIP_PLANNER) {
    const plan = await runPlannerV2(persona);
    const pt = await extract(plan.turns, { jobTitle: gold.jobTitle });
    mp = await missingGold(gold.gold, pt);
    mp.forEach((task) => missPlanner.push({ role: gold.jobTitle, task }));
  }
  console.log(`  ${persona.name.padEnd(24)} ${gold.jobTitle.padEnd(26)} missed: scripted ${mb.length}/${gold.gold.length}${SKIP_PLANNER ? "" : `, planner ${mp.length}/${gold.gold.length}`}`);
}

console.log(`\n${"═".repeat(74)}\n  SCRIPTED misses — clustered (what even the best interview is blind to)\n${"═".repeat(74)}`);
console.log(`  ${missScripted.length}/${goldTotal} gold tasks missed across ${selected.length} personas\n`);
for (const c of await clusterMisses(missScripted)) {
  console.log(`  ${String(c.count).padStart(3)}  ${c.name}`);
  for (const e of (c.examples || []).slice(0, 4)) console.log(`        · ${e}`);
}

if (!SKIP_PLANNER) {
  console.log(`\n${"═".repeat(74)}\n  PLANNER misses — clustered (gap-driven v2)\n${"═".repeat(74)}`);
  console.log(`  ${missPlanner.length}/${goldTotal} gold tasks missed across ${selected.length} personas\n`);
  for (const c of await clusterMisses(missPlanner)) {
    console.log(`  ${String(c.count).padStart(3)}  ${c.name}`);
    for (const e of (c.examples || []).slice(0, 4)) console.log(`        · ${e}`);
  }
}
console.log();
