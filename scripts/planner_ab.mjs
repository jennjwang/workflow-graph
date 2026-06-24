// A/B: scripted interview (current) vs SparkMe-style PLANNER interviews.
//
// Both drive the SAME persona simulators, so differences come from the interviewer
// STRATEGY, not the participant. Metrics mirror the SparkMe paper:
//   - topic coverage  (fraction of an LLM gold task set surfaced)
//   - novelty         (unique tasks elicited; tasks per turn)
//   - efficiency      (turns; client tokens / $ spent)
//   - question quality: open-ended %, LEADING %, REDUNDANT %  (LLM judge)
//
// Two planners:
//   v1 = rollout planner: propose N candidates, simulate each, pick max expected
//        new tasks. High fidelity, high latency (≈3 calls deep on the critical path).
//   v2 = single deliberative call per turn (≈1 call critical path): coverage-AWARE
//        utility (cover unmet guide topics AND surface new tasks), with explicit
//        open / non-leading / non-repetitive guardrails and an in-call stop decision.
//
//   node --env-file=.env scripts/planner_ab.mjs            # default 3 personas
//   node --env-file=.env scripts/planner_ab.mjs 5
//   node --env-file=.env scripts/planner_ab.mjs "Accountant"
//
// Requires the dev server on :3001 (extractor + the scripted driver's evaluate-answer).
import OpenAI from "openai";
import { PERSONAS, runInterview, QUESTIONS } from "./sim_interview.mjs";

const API = process.env.SIM_API || "http://localhost:3001";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const SIM_MODEL = process.env.SIM_PARTICIPANT_MODEL || "gpt-4o-mini"; // participant + rollouts
const PLANNER_MODEL = process.env.PLANNER_MODEL || "gpt-4o";          // planning + judging

const MIN_TURNS = 5;
const MAX_TURNS = 12;        // same budget as the scripted interview (~12 turns)
const N_CANDIDATES = 3;      // v1 candidates per turn
const STOP_MIN = 1.0;        // v1: stop once best candidate's expected NEW tasks < this

// ── Cost / token tracking (budget guard) ──────────────────────────────────────
const PRICES = { // $ per 1M tokens (input, output)
  "gpt-4o": [2.5, 10],
  "gpt-4o-mini": [0.15, 0.6],
};
let spend = 0;
let clientCalls = 0;
async function chat(args) {
  const r = await client.chat.completions.create(args);
  clientCalls += 1;
  const [pin, pout] = PRICES[args.model] || [0, 0];
  const u = r.usage || {};
  spend += ((u.prompt_tokens || 0) * pin + (u.completion_tokens || 0) * pout) / 1e6;
  return r;
}
const money = () => `$${spend.toFixed(3)}`;

const arg = process.argv[2];
const selected = !arg
  ? PERSONAS.slice(0, 3)
  : /^\d+$/.test(arg)
    ? PERSONAS.slice(0, Number(arg))
    : PERSONAS.filter((p) => p.name === arg);

// ── Shared participant simulator (identical for every condition) ───────────────
async function participant(persona, question, history) {
  const res = await chat({
    model: SIM_MODEL,
    temperature: 0.85,
    messages: [
      {
        role: "system",
        content: `${persona.brief}\n\nYou are being interviewed about your work. Answer in first person, in character, like a real person typing in a chat — natural, no narration. Real people don't volunteer much: keep answers SHORT (usually one sentence). Don't over-explain or enumerate unless your persona is an over-explainer. Output ONLY your reply text.`,
      },
      {
        role: "user",
        content: `Conversation so far:\n${history.length ? history.join("\n") : "(none yet)"}\n\nInterviewer: ${question}\n\nYour answer:`,
      },
    ],
  });
  return res.choices[0].message.content.trim();
}

// ── Task extraction via the REAL endpoint (server-side; same for all) ──────────
async function extract(turns, profile) {
  const backgroundTranscript = turns.map((t, i) => ({
    field: t.field || "q", question: t.question, answer: t.answer, isFollowUp: !!t.isFollowUp, timestamp: i,
  }));
  const r = await fetch(`${API}/api/extract-interview-tasks`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ backgroundTranscript, userProfile: profile }),
  });
  const j = await r.json();
  return Array.isArray(j.tasks) ? j.tasks : [];
}

// New concrete recurring tasks an answer adds beyond `covered`.
async function newTasksFrom(answer, covered) {
  const r = await chat({
    model: SIM_MODEL, temperature: 0, response_format: { type: "json_object" },
    messages: [
      { role: "system", content: `Count the NEW, concrete, recurring WORK TASKS an interview answer reveals that are NOT already in the covered list (compare meaning, not wording; ignore vague/non-task statements). Return JSON {"tasks":["..."],"count":<int>}.` },
      { role: "user", content: `COVERED:\n${covered.map((t) => `- ${t}`).join("\n") || "(none)"}\n\nANSWER:\n${answer}\n\nList only the genuinely new tasks.` },
    ],
  });
  try { const j = JSON.parse(r.choices[0].message.content); const tasks = (j.tasks || []).filter((t) => typeof t === "string" && t.trim()); return { count: tasks.length, tasks }; }
  catch { return { count: 0, tasks: [] }; }
}

const GUIDE = QUESTIONS.map((q) => `- ${q.field}: ${q.text}`).join("\n");

// ── v1: rollout planner ───────────────────────────────────────────────────────
async function proposeCandidates(history, covered, asked) {
  const r = await chat({
    model: PLANNER_MODEL, temperature: 0.5, response_format: { type: "json_object" },
    messages: [
      { role: "system", content: `You plan a work-task elicitation interview. GOAL: surface as many of the participant's REAL recurring tasks as possible in few turns. Propose EXACTLY ${N_CANDIDATES} candidate NEXT questions, each a DIFFERENT strategy:
1. DEEPEN — drill into the most task-rich open thread for its concrete sub-tasks.
2. COVER — move to the most valuable guide topic not yet covered.
3. EMERGENT — probe a likely role-specific area not yet touched.
Every question: open, NON-LEADING (never name a task you hope to hear), one sentence, and NOT a repeat or rephrasing of any already-asked question. Return JSON {"candidates":[{"type":"...","question":"..."}]}.

Guide topics:\n${GUIDE}` },
      { role: "user", content: `Conversation so far:\n${history.join("\n") || "(none yet)"}\n\nAlready-asked questions (do NOT repeat or rephrase):\n${asked.map((q) => `- ${q}`).join("\n") || "(none)"}\n\nTasks already covered:\n${covered.map((t) => `- ${t}`).join("\n") || "(none)"}\n\nPropose ${N_CANDIDATES} candidate next questions.` },
    ],
  });
  try { const j = JSON.parse(r.choices[0].message.content); return (j.candidates || []).filter((c) => c && c.question); }
  catch { return []; }
}

async function runPlannerV1(persona) {
  const history = [], turns = [], covered = [], asked = [];
  const first = QUESTIONS[0].text;
  let answer = await participant(persona, first, history);
  history.push(`Interviewer: ${first}`, `Participant: ${answer}`); asked.push(first);
  turns.push({ field: QUESTIONS[0].field, question: first, answer });
  covered.push(...(await newTasksFrom(answer, covered)).tasks);

  let stopReason = "max-turns";
  while (turns.length < MAX_TURNS) {
    const candidates = await proposeCandidates(history, covered, asked);
    if (!candidates.length) { stopReason = "no-candidates"; break; }
    const scored = await Promise.all(candidates.map(async (c) => {
      const simAns = await participant(persona, c.question, history);
      return { ...c, est: (await newTasksFrom(simAns, covered)).count };
    }));
    scored.sort((a, b) => b.est - a.est);
    const best = scored[0];
    if (turns.length >= MIN_TURNS && best.est < STOP_MIN) { stopReason = "low-utility"; break; }
    answer = await participant(persona, best.question, history);
    history.push(`Interviewer: ${best.question}`, `Participant: ${answer}`); asked.push(best.question);
    turns.push({ field: `plan:${best.type}`, question: best.question, answer, isFollowUp: true });
    covered.push(...(await newTasksFrom(answer, covered)).tasks);
  }
  return { turns, stopReason, critPath: 3 };
}

// ── v2: coverage-backbone planner (1 call/turn) ───────────────────────────────
// Guarantees the script's BREADTH (every guide topic gets a question) while adding
// the planner's wins: adaptive deepening on rich threads, and strict open /
// non-leading / non-repetitive phrasing. Stop is code-driven (breadth done +
// novelty saturated), so a malformed planner reply can't end the interview early.
async function planNext(history, covered, asked, remaining) {
  const r = await chat({
    model: PLANNER_MODEL, temperature: 0.4, response_format: { type: "json_object" },
    messages: [
      { role: "system", content: `You are an expert interviewer eliciting someone's real recurring WORK TASKS. Choose the SINGLE best next question.

PRIORITIES:
1) BREADTH FIRST — the still-uncovered guide topics are listed. Normally ask a question that opens one of them.
2) DEPTH WHEN RICH — if the participant's LAST answer opened a clearly task-rich thread worth one more concrete probe, you may deepen instead; never deepen the same thread twice in a row.

QUESTION RULES (hard):
- OPEN-ENDED — MUST begin with "What", "How", "Walk me through", or "Tell me about". NEVER a yes/no stem ("Do you", "Are there", "Is there", "Have you") — those are closed and leading.
- NON-LEADING — never name or hint at a specific task/answer you hope to hear, and DO NOT put examples or a menu of possible answers in the question (examples lead the witness). For hands-on/clinical/manual roles especially: ask about the AREA in plain words; do NOT name domain-specific procedures or tasks.
- NOT REPETITIVE — never repeat or rephrase any already-asked question; open a different thread than the last.
- One plain, conversational sentence.

FINAL CHECK before you answer — re-read your question and REWRITE it if it: names or hints at any specific task, contains examples or a menu of possible answers ("like X, Y, or Z"), could be answered yes/no, does NOT start with What/How/Walk me through/Tell me about, or echoes an earlier question. Only return a question that passes all five.

Return JSON {"topic":"<the guide-topic field this covers, or 'deepen' or 'emergent'>","question":"..."}. ALWAYS return a question.

Guide topics:\n${GUIDE}` },
      { role: "user", content: `Uncovered guide topics: ${remaining.join(", ") || "(none — all covered)"}\n\nConversation so far:\n${history.join("\n") || "(none yet)"}\n\nAlready-asked questions (do NOT repeat or rephrase):\n${asked.map((q) => `- ${q}`).join("\n") || "(none)"}\n\nTasks already covered:\n${covered.map((t) => `- ${t}`).join("\n") || "(none)"}\n\nChoose the single best next question.` },
    ],
  });
  try { const j = JSON.parse(r.choices[0].message.content); return { topic: j.topic ?? null, question: j.question ?? null }; }
  catch { return { topic: null, question: null }; }
}

async function runPlannerV2(persona) {
  const history = [], turns = [], covered = [], asked = [];
  let remaining = QUESTIONS.slice(1).map((q) => q.field); // jobTitle is covered by the seed
  const first = QUESTIONS[0].text;
  let answer = await participant(persona, first, history);
  history.push(`Interviewer: ${first}`, `Participant: ${answer}`); asked.push(first);
  turns.push({ field: QUESTIONS[0].field, question: first, answer });
  const seed = await newTasksFrom(answer, covered);
  covered.push(...seed.tasks);
  const yields = [seed.count];

  let stopReason = "max-turns";
  while (turns.length < MAX_TURNS) {
    const plan = await planNext(history, covered, asked, remaining);
    if (!plan.question) { stopReason = "no-question"; break; }
    answer = await participant(persona, plan.question, history);
    history.push(`Interviewer: ${plan.question}`, `Participant: ${answer}`); asked.push(plan.question);
    turns.push({ field: `plan:${plan.topic || "?"}`, question: plan.question, answer, isFollowUp: true });
    const nt = await newTasksFrom(answer, covered);
    covered.push(...nt.tasks);
    yields.push(nt.count);
    if (plan.topic && remaining.includes(plan.topic)) remaining = remaining.filter((t) => t !== plan.topic);
    // Code-driven stop: every guide topic covered AND the last two turns added
    // nothing genuinely new. Breadth is guaranteed before any stop is considered.
    if (turns.length >= MIN_TURNS && remaining.length === 0 && yields.slice(-2).every((y) => y === 0)) {
      stopReason = "saturated"; break;
    }
  }
  return { turns, stopReason, critPath: 1 };
}

// ── Gold set + coverage + question-quality judge ──────────────────────────────
async function goldSet(persona) {
  const r = await chat({
    model: PLANNER_MODEL, temperature: 0, response_format: { type: "json_object" },
    messages: [
      { role: "system", content: `Given a worker persona, infer their job title and list the GOLD SET of ~15 core recurring WORK TASKS a competent person in that exact role does. O*NET style: verb-led, concrete, role-distinctive, non-overlapping. Return JSON {"jobTitle":"...","gold":["...", ...]}.` },
      { role: "user", content: `Persona: ${persona.brief}` },
    ],
  });
  const j = JSON.parse(r.choices[0].message.content);
  return { jobTitle: j.jobTitle || persona.name, gold: Array.isArray(j.gold) ? j.gold : [] };
}

async function coverage(gold, elicited) {
  const r = await chat({
    model: PLANNER_MODEL, temperature: 0, response_format: { type: "json_object" },
    messages: [
      { role: "system", content: `For each GOLD task, decide if it is COVERED by any ELICITED task (same activity, compare meaning not wording). Return JSON {"covered":<int>,"n":<int>}.` },
      { role: "user", content: `GOLD:\n${gold.map((t) => `- ${t}`).join("\n")}\n\nELICITED:\n${elicited.map((t) => `- ${t}`).join("\n") || "(none)"}` },
    ],
  });
  try { const j = JSON.parse(r.choices[0].message.content); return (j.covered ?? 0) / (j.n ?? gold.length); }
  catch { return 0; }
}

// SparkMe-style question-quality judge: open-ended %, leading %, redundant %.
async function judgeQuestions(turns) {
  const qs = turns.map((t) => t.question);
  const r = await chat({
    model: PLANNER_MODEL, temperature: 0, response_format: { type: "json_object" },
    messages: [
      { role: "system", content: `Judge a list of interviewer questions (in order). For each, decide:
- open: true if open-ended (invites description in own words), false if closed/yes-no.
- leading: true if it suggests/embeds a specific expected answer or names the task it hopes to hear.
- redundant: true if it substantially repeats or rephrases an EARLIER question in the list.
Return JSON {"open":<count true>,"leading":<count true>,"redundant":<count true>,"n":<list length>}.` },
      { role: "user", content: qs.map((q, i) => `${i + 1}. ${q}`).join("\n") },
    ],
  });
  try { const j = JSON.parse(r.choices[0].message.content); const n = j.n || qs.length; return { openPct: (j.open ?? 0) / n, leadingPct: (j.leading ?? 0) / n, redundantPct: (j.redundant ?? 0) / n }; }
  catch { return { openPct: 0, leadingPct: 0, redundantPct: 0 }; }
}

async function evalCondition(label, turns, gold) {
  const tasks = await extract(turns, { jobTitle: gold.jobTitle });
  const [cov, quality] = await Promise.all([coverage(gold.gold, tasks), judgeQuestions(turns)]);
  return { label, turns: turns.length, tasks: tasks.length, cov, ...quality };
}

// ── Run ───────────────────────────────────────────────────────────────────────
const rows = [];
for (const persona of selected) {
  console.log(`\n${"═".repeat(74)}\n  ${persona.name}\n${"═".repeat(74)}`);
  const gold = await goldSet(persona);
  console.log(`  role: ${gold.jobTitle} | gold: ${gold.gold.length} | spend so far ${money()}`);

  const base = await runInterview(persona, { quiet: true });
  const v1 = await runPlannerV1(persona);
  const v2 = await runPlannerV2(persona);

  const r = {
    persona: persona.name,
    scripted: await evalCondition("scripted", base.turns, gold),
    v1: await evalCondition("v1-rollout", v1.turns, gold),
    v2: await evalCondition("v2-deliberative", v2.turns, gold),
    crit: { scripted: 1, v1: v1.critPath, v2: v2.critPath },
    stop: { v1: v1.stopReason, v2: v2.stopReason },
  };
  rows.push(r);
  const fmt = (c) => `turns=${c.turns} cov=${(c.cov * 100).toFixed(0)}% lead=${(c.leadingPct * 100).toFixed(0)}% redun=${(c.redundantPct * 100).toFixed(0)}% open=${(c.openPct * 100).toFixed(0)}%`;
  console.log(`  SCRIPTED       : ${fmt(r.scripted)}`);
  console.log(`  v1 ROLLOUT     : ${fmt(r.v1)}  (stop ${r.stop.v1})`);
  console.log(`  v2 BACKBONE    : ${fmt(r.v2)}  (stop ${r.stop.v2})`);
}

// ── Summary ─────────────────────────────────────────────────────────────────
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const col = (k, m) => avg(rows.map((r) => r[k][m]));
const p = (x) => `${(x * 100).toFixed(0)}%`;
const conds = [["scripted", "scripted"], ["v1", "v1 rollout"], ["v2", "v2 backbone"]];
console.log(`\n${"═".repeat(74)}\n  SUMMARY (avg over ${rows.length} personas)\n${"═".repeat(74)}`);
console.log("  condition          turns  coverage  tasks/turn  leading  redundant  open  critPath");
for (const [k, name] of conds) {
  console.log(
    `  ${name.padEnd(18)} ${col(k, "turns").toFixed(1).padEnd(6)} ${p(col(k, "cov")).padEnd(9)} ` +
    `${avg(rows.map((r) => r[k].tasks / r[k].turns)).toFixed(2).padEnd(11)} ${p(col(k, "leadingPct")).padEnd(8)} ` +
    `${p(col(k, "redundantPct")).padEnd(10)} ${p(col(k, "openPct")).padEnd(5)} ${avg(rows.map((r) => r.crit[k])).toFixed(0)}`,
  );
}
console.log(`\n  total spend: ${money()}  |  client calls: ${clientCalls}`);
console.log();
