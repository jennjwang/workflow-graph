// Generate SIMULATED Computer & Information Research Scientist sessions in onet's schema.
// CS variant of gen_onet_sim_sessions.mjs — same live-sim pipeline (WG server :3001 + OpenAI),
// different SOC + personas. Files are numbered from START+1 so they ADD to the existing CS fixtures
// (sim-cs-researcher-01..06) instead of overwriting them.
//
//   node --env-file=.env scripts/gen_onet_sim_sessions_cs.mjs [N]   (default 6)

import { runInterview } from "./sim_interview.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

const API = process.env.SIM_API || "http://localhost:3001";
const OUT_DIR = process.env.ONET_FIXTURES || "/Users/jenniferwang/PhD/onet/tests/fixtures";
const COUNT = Number(process.env.SIM_COUNT || 20);
const N = Number(process.argv[2] || 6);
const START = Number(process.env.SIM_START || 6);   // existing CS fixtures are 01..06
const SOC = { selectedCode: "15-1221.00", selectedTitle: "Computer and Information Research Scientists" };

// Six NEW research sub-roles (distinct from the first batch: ml/nlp/cv/systems/rl/theory).
const PERSONAS = [
  { name: "Data mining and recommender systems researcher", brief:
    "You are a research scientist working on data mining and recommender systems at a large tech company, 5 years in. You design ranking and recommendation models, run large-scale offline evaluations and online A/B tests, mine behavioral logs for signals, and write up findings. Answer matter-of-factly and briefly." },
  { name: "ML security and privacy researcher", brief:
    "You are a research scientist in machine-learning security and privacy at an industry lab, 6 years in. You study adversarial robustness, membership-inference and data-extraction attacks, and differential-privacy training; you build threat models, run attack/defense experiments, and disclose findings. Answer plainly, don't over-explain." },
  { name: "Human-AI interaction (HCI) researcher", brief:
    "You are an HCI research scientist studying human-AI interaction, 4 years in. You design user studies, build interactive prototypes, run usability evaluations and annotation studies, analyze qualitative and quantitative results, and publish. Concrete but brief." },
  { name: "Data systems and databases researcher", brief:
    "You are a research scientist working on large-scale data systems and databases, 7 years in. You design query-processing and storage techniques, prototype systems, run performance benchmarks on clusters, profile bottlenecks, and write papers. Precise but fairly terse." },
  { name: "Programming languages and compilers researcher", brief:
    "You are a research scientist in programming languages and compilers, 5 years in. You design type systems and program analyses, prove correctness properties, implement compiler passes, benchmark generated code, and publish. Careful and plain-spoken." },
  { name: "Computer graphics and rendering researcher", brief:
    "You are a research scientist in computer graphics and rendering, 6 years in. You develop rendering and geometry-processing algorithms, implement GPU prototypes, evaluate visual quality and performance, and write up results. Practical and to the point." },
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
  const tasks = [];
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
const occSlug = SOC.selectedTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const OCC_DIR = `${OUT_DIR}/${occSlug}`;
mkdirSync(OCC_DIR, { recursive: true });

let i = START;
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
  const file = `sim-cs-researcher-${String(i).padStart(2, "0")}-${slug(persona.name)}.json`;
  writeFileSync(`${OCC_DIR}/${file}`, JSON.stringify(session, null, 2));
  process.stdout.write(` … ${session.selectedTasks.length} tasks → ${file}\n`);
}

console.log(`\nDone: ${Math.min(N, PERSONAS.length)} simulated CS-researcher sessions → ${OCC_DIR}`);
