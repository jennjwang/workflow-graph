// Prototype: assess a worker's EXTRACTED tasks, have an LLM find coverage GAPS
// (recurring role tasks they didn't mention), cluster them into areas, and draft
// ONE open, non-leading follow-up question per area to probe in a re-interview.
//
// Offline / read-only. Extraction goes through the live server (localhost:3001);
// gap analysis + question drafting is a direct LLM call. Nothing is saved.
//
//   node --env-file=.env scripts/gap_probe.mjs
import { readFileSync } from "node:fs";
import OpenAI from "openai";

const API = process.env.SIM_API || "http://localhost:3001";
const MODEL = process.env.GAP_MODEL || "gpt-4o";
const MAX_AREAS = Number(process.env.GAP_MAX_AREAS) || 3;   // hard cap on gap questions
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
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

const SYSTEM = `You are improving a work-task interview. The participant was interviewed and we extracted the tasks they MENTIONED. Find the COVERAGE GAPS — recurring tasks someone in THIS specific role almost certainly does but did NOT mention — and group them into a few AREAS we can probe with ONE open follow-up question each.

Return ONLY JSON:
{
  "areas": [
    {
      "area": "<short label for this slice of the job>",
      "hiddenGapTasks": ["<specific recurring task they did NOT mention>", "..."],
      "anchor": "<a VERBATIM quote (exact words) from the participant's answers below that this area connects to, or null>",
      "question": "<one OPEN, NON-LEADING question inviting them to describe work in this area WITHOUT naming any hidden gap task>"
    }
  ]
}

GAPS — SUBSTANTIVE AND ROLE-DISTINCTIVE ONLY (NO FILLER):
- Each gap must be a CONCRETE, recurring task specific to THIS role — name the actual artifact, system, document, or action a person in this exact job does. Grounded in their job title, responsibilities, and week.
- BAN GENERIC FILLER. Reject any candidate that would apply to almost any office/professional job, e.g. "stay updated with industry trends", "attend training", "keep skills up to date", "prepare administrative reports", "maintain records", "communicate with internal teams", "coordinate with colleagues", "manage your time", "respond to emails". These are NOT gaps worth an interview question. If a whole area reduces to filler, DROP the area.
- A gap is NOT already covered by a mentioned task (compare meaning, not wording). If it's a kind/case of something they already said, it is NOT a gap.
- NEVER import tasks from another job; never invent something implausible.
- Return AT MOST ${MAX_AREAS} areas, most central/likely FIRST. QUALITY OVER QUANTITY — if the interview already covers the role well, return FEWER (even zero) rather than padding. A short list of real, specific gaps beats a long list with filler.

ANCHORS — VERBATIM ONLY:
- "anchor" must be an EXACT substring of the participant's answers below (copy their words letter-for-letter). Do NOT paraphrase, summarize, or invent. If you cannot quote them exactly for this area, set "anchor" to null.
- When anchor is null, the question must NOT begin with "You mentioned" or claim they said anything.

QUESTIONS — CRITICAL, MUST NOT LEAD:
- NEVER name or hint at a hidden gap task. If a hidden task is "reconcile intercompany balances", do NOT say "reconcile", "intercompany", or "balances" — ask about the AREA openly.
- Anchor to the participant's OWN verbatim words when anchor is non-null ("You mentioned <their exact phrase> — ...").
- Phrase as an open invitation answerable with NEW tasks in their words, or with "no": "is there anything else you regularly do around ___?", "what does ___ usually involve for you?".
- One sentence, plain and conversational. One question per area. "No" must be a fine answer.`;

function transcriptText(turns = []) {
  return turns
    .map((t) => `Q: ${String(t.question || "").trim()}\nA: ${String(t.answer || "").trim()}`)
    .join("\n\n");
}

async function gapProbe(profile, mentioned, transcript) {
  const user = `Job title: ${profile.jobTitle}
Responsibilities: ${profile.responsibilities || "(none given)"}
Typical week: ${profile.typicalWeek || "(none given)"}

MENTIONED tasks (already covered — find what's MISSING, do not repeat these):
${mentioned.map((t) => `- ${t}`).join("\n")}

FULL INTERVIEW TRANSCRIPT (anchors must be exact quotes from the A: lines):
${transcript}

Identify the coverage gaps, grouped into areas, each with one open non-leading question.`;
  const r = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.4,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: user },
    ],
  });
  return JSON.parse(r.choices[0].message.content).areas ?? [];
}

for (const f of FILES) {
  const d = JSON.parse(readFileSync(`${DATA}/${f}`, "utf8"));
  const p = d.userProfile;
  console.log("\n" + "═".repeat(80));
  console.log("  " + (p.jobTitle || "?").replace(/\s+/g, " ").trim().slice(0, 76));
  console.log("═".repeat(80));

  const mentioned = await extract(d.backgroundTranscript, p);
  console.log(`  MENTIONED tasks extracted: ${mentioned.length}`);

  const transcript = transcriptText(d.backgroundTranscript);
  const answersBlob = d.backgroundTranscript.map((t) => String(t.answer || "")).join("\n");
  let areas = await gapProbe(p, mentioned, transcript);
  if (areas.length > MAX_AREAS) areas = areas.slice(0, MAX_AREAS);   // hard cap

  console.log(`\n  GAP-PROBE PLAN — ${areas.length} area(s) (cap ${MAX_AREAS}):\n`);
  areas.forEach((a, i) => {
    console.log(`  ${i + 1}. AREA: ${a.area}`);
    if (a.anchor) {
      const verbatim = answersBlob.includes(a.anchor);
      console.log(`     anchored to: "${a.anchor}" ${verbatim ? "✓ verbatim" : "✗ NOT IN TRANSCRIPT"}`);
    }
    console.log(`     ❓ WOULD ASK: ${a.question}`);
    console.log(`     ↪ hoping to surface (hidden, not named):`);
    (a.hiddenGapTasks || []).forEach((t) => console.log(`         · ${t}`));
    console.log();
  });
}
