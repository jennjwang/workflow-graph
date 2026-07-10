// Generate SIMULATED "Computer and Information Research Scientists" sessions in onet's schema,
// for onet/tests/fixtures/.  (Sibling of gen_onet_sim_sessions.mjs, which does accountants.)
//
//   node --env-file=.env scripts/gen_cs_researcher_sim_sessions.mjs [N]   (default 6)
//
// Drives the live sim end-to-end (real WG server on :3001 + OpenAI): an LLM persona is
// interviewed via /api/evaluate-answer, tasks are extracted (/api/extract-interview-tasks)
// and generated (/api/generate-tasks-from-interview), then each persona is assembled into
// an onet-schema session JSON (selectedTasks + taskItems + occupationSelection + transcript)
// and written to onet/tests/fixtures/ for the pipeline's real-API test to process.
//
// Sim caveat: no participant edits/additions, so every task is status="confirmed" and all
// share the same SOC — these exercise onet's atomize + dedup, not the added/edited path.

import { runInterview } from "./sim_interview.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

const API = process.env.SIM_API || "http://localhost:3001";
const OUT_DIR = process.env.ONET_FIXTURES || "/Users/jenniferwang/PhD/onet/tests/fixtures";
const COUNT = Number(process.env.SIM_COUNT || 30);
const N = Number(process.argv[2] || 6);
const SOC = { selectedCode: "15-1221.00", selectedTitle: "Computer and Information Research Scientists" };

// Six distinct research-scientist sub-roles — shared research core (design experiments, run
// evaluations, publish) + specialization-specific divergence.
const PERSONAS = [
  { name: "ML research scientist (industry lab)", brief:
    "You are a machine learning research scientist at a large industry AI lab, 5 years in (PhD). You design and run training experiments, curate datasets, implement and ablate model architectures, tune hyperparameters, analyze results, and write up findings for papers and internal reports. Answer matter-of-factly and briefly." },
  { name: "NLP / large language model researcher", brief:
    "You are an NLP research scientist focused on large language models, 4 years in. You build evaluation benchmarks, fine-tune and instruction-tune models, run inference experiments, do error analysis on model outputs, design prompting studies, and collaborate on paper submissions. Answer plainly, don't over-explain." },
  { name: "Computer vision research scientist", brief:
    "You are a computer vision research scientist at a research institute, 6 years in. You collect and annotate image datasets, train and evaluate detection and segmentation models, benchmark against baselines, profile inference performance, and present results at reading groups. Precise but fairly terse." },
  { name: "Systems / distributed computing researcher", brief:
    "You are a computer systems researcher working on distributed training and large-scale infrastructure, 7 years in. You design and prototype distributed algorithms, run performance and scaling experiments on GPU clusters, profile bottlenecks, write simulators, and document architectural trade-offs. Concrete but brief." },
  { name: "Reinforcement learning / robotics researcher", brief:
    "You are a reinforcement learning research scientist working on robotics and control, 4 years in. You design simulation environments, implement RL algorithms, run training sweeps, evaluate policies in sim and on hardware, analyze failure cases, and write up experiments. Practical and to the point." },
  { name: "Theoretical CS / algorithms researcher", brief:
    "You are a theoretical computer science researcher (algorithms and complexity) at a university, 8 years in. You formulate problems, prove theorems and bounds, design and analyze algorithms, review related literature, write proofs up for conference submissions, and advise graduate students. Careful and plain-spoken." },
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
  const file = `sim-cs-researcher-${String(i).padStart(2, "0")}-${slug(persona.name)}.json`;
  writeFileSync(`${OCC_DIR}/${file}`, JSON.stringify(session, null, 2));
  process.stdout.write(` … ${session.selectedTasks.length} tasks → ${file}\n`);
}

console.log(`\nDone: ${Math.min(N, PERSONAS.length)} simulated CS-researcher sessions → ${OCC_DIR}`);
