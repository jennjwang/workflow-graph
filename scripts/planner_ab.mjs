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
const MAX_TURNS = Number(process.env.MAX_TURNS) || 15; // question budget (env-overridable)
// CRITERIA_GATE=0 reverts v2 to the OLD single-touch backbone (a topic is struck
// off the moment it's asked, no coverage judge) — for A/B'ing the criteria-gating.
const CRITERIA_GATE = process.env.CRITERIA_GATE !== "0";
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
  : /^\d+:\d+$/.test(arg)
    ? PERSONAS.slice(...arg.split(":").map(Number)) // "3:9" → personas 3..8
    : /^\d+$/.test(arg)
      ? PERSONAS.slice(0, Number(arg))
      : PERSONAS.filter((p) => p.name === arg);

// ── Shared participant simulator (identical for every condition) ───────────────
async function participant(persona, question, history) {
  const res = await chat({
    model: SIM_MODEL,
    temperature: 0.3,
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

// The proven closing catch-all (from the guide) — asked LAST, after the spine and
// the emergent gap-probing, to sweep up any invisible/relational tasks still
// unnamed. Keeps the "Last one:" framing since it's genuinely the final question.
const SHADOW_Q = QUESTIONS.find((q) => q.closingQuestion)?.closingQuestion
  || "Last one: if someone shadowed you for two weeks, what tasks would they see that we haven't named yet?";

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
// CRITERIA-GATED COVERAGE: which of the given guide TOPICS does the conversation
// now ADEQUATELY satisfy, per each topic's own criteria? One batched call. This is
// what lets the backbone strike a topic only when its bar is MET (like the scripted
// interviewer's coverage judgment), instead of the moment it's asked once.
async function coveredTopics(conversation, topics) {
  if (!topics.length) return [];
  const r = await chat({
    model: PLANNER_MODEL, temperature: 0, response_format: { type: "json_object" },
    messages: [
      { role: "system", content: `You judge interview COVERAGE. For each TOPIC, decide whether the conversation now ADEQUATELY satisfies that topic's criteria. Be strict — a topic is covered only if its criteria are genuinely MET by what the participant actually said, not merely touched on or named in passing. Return JSON {"covered":["<field of each adequately-covered topic>"]}.` },
      { role: "user", content: `CONVERSATION:\n${conversation || "(none yet)"}\n\nTOPICS:\n${topics.map((t) => `- ${t.field}: ${t.text}\n   criteria: ${(t.criteria || []).join(" | ")}`).join("\n")}` },
    ],
  });
  try { const j = JSON.parse(r.choices[0].message.content); return Array.isArray(j.covered) ? j.covered : []; }
  catch { return []; }
}

async function planNext(history, covered, asked, remainingTopics) {
  const r = await chat({
    model: PLANNER_MODEL, temperature: 0.4, response_format: { type: "json_object" },
    messages: [
      { role: "system", content: `You are an expert interviewer building a COMPLETE picture of someone's recurring WORK TASKS in as few turns as possible. Each turn, advance the BIGGEST COVERAGE GAP:

1) PRIORITIZE UNCOVERED GUIDE TOPICS — the uncovered topics are listed with WHAT EACH STILL NEEDS (its criteria). Pick the most valuable uncovered topic and ask a question that moves it toward what it still needs. Keep working the SAME topic across turns until its criteria are met — don't touch it once and move on.
2) DEPTH OVER BREADTH WITHIN A TOPIC — if a topic's criteria call for the concrete sub-tasks of a dominant activity, drill into the distinct KINDS of work inside it rather than asking a shallow one-liner.
3) Only once all guide topics are genuinely covered, probe EMERGENT role tasks not yet surfaced — but ONLY while there's a genuinely valuable, non-redundant area left. END the interview as soon as it's complete; do NOT pad it with marginal or repetitive questions.
ASK ONE QUESTION that gets them to describe the tasks themselves — UNLESS you're done (see ENDING).

ENDING — set "done": true once every guide topic is covered AND you see no further genuinely valuable, non-redundant area of their work to ask about. When done, you may omit the question. Don't keep asking just to fill turns.

QUESTION RULES (hard):
- OPEN-ENDED — must invite them to describe their work in their own words and must NOT be answerable yes/no. Use any natural open phrasing you like (vary it freely), but NEVER a closed / yes-no stem ("Do you", "Can you", "Could you", "Are there", "Is there", "Have you", "Did you", "Would you say", "Is it") — those force a yes/no and lead. Prefer the imperative ("Walk me through…") over "Can you walk me through…".
- NON-LEADING — never name or hint at a specific task/answer you hope to hear, and DO NOT put examples or a menu of possible answers in the question (examples lead the witness). For hands-on/clinical/manual roles especially: ask about the AREA in plain words; do NOT name domain-specific procedures or tasks.
- NOT REPETITIVE — never repeat or rephrase any already-asked question; open a different thread or push deeper than the last.
- CONVERSATIONAL — ask it the way a warm, curious colleague actually would in a chat, NOT like a survey or interrogation: plain everyday language, a little casual is good, contractions fine. Do NOT tack "in your role as a [job title]" onto questions, and don't pile up clinical noun-phrases ("outputs or deliverables you produce or maintain"). One sentence.

FINAL CHECK before you answer — re-read your question and REWRITE it if it: names or hints at any specific task, contains examples or a menu of possible answers ("like X, Y, or Z"), could be answered yes/no (e.g. opens with Do/Can/Could/Are/Is/Have/Did/Would), or echoes an earlier question. Only return a question that passes all four. Phrasing is otherwise free — vary it naturally.

Return JSON {"gap":"<the specific uncovered area of THEIR work you are targeting this turn>","topic":"<the guide-topic field this advances, or 'emergent'>","question":"...","done":<bool>}. Return a question unless done is true.` },
      { role: "user", content: `UNCOVERED guide topics — and what each STILL NEEDS:\n${remainingTopics.length ? remainingTopics.map((t) => `- ${t.field}: ${t.text}\n   still needs: ${(t.criteria || []).join(" | ")}`).join("\n") : "(none — all guide topics covered; probe emergent tasks)"}\n\nConversation so far:\n${history.join("\n") || "(none yet)"}\n\nAlready-asked questions (do NOT repeat or rephrase):\n${asked.map((q) => `- ${q}`).join("\n") || "(none)"}\n\nTasks already covered:\n${covered.map((t) => `- ${t}`).join("\n") || "(none)"}\n\nAdvance the most valuable uncovered topic toward what it still needs (or probe emergent tasks if all are covered) and ask the single best next question.` },
    ],
  });
  try { const j = JSON.parse(r.choices[0].message.content); return { gap: j.gap ?? null, topic: j.topic ?? null, question: j.question ?? null, done: !!j.done }; }
  catch { return { gap: null, topic: null, question: null, done: false }; }
}

// EMERGENT phase, TASK-SPACE gap-driven: once the spine is covered, picture the
// COMPLETE task inventory for the role, diff it against the tasks GATHERED, and
// target the biggest MISSING area (not a generic "what else?"). Sets done when no
// substantive task gap remains — that's how the interview genuinely finishes.
async function emergentGap(history, covered, asked) {
  const r = await chat({
    model: PLANNER_MODEL, temperature: 0.4, response_format: { type: "json_object" },
    messages: [
      { role: "system", content: `You are finishing a work-task interview. From the conversation, infer the participant's ROLE and what they've already described, then:
1) Think about the recurring tasks someone in THIS exact role does, and which matter MOST — the areas most CENTRAL, frequent, or consequential to the role.
2) DIFF against the tasks ALREADY GATHERED (below). Among the areas NOT yet surfaced, target the MOST IMPORTANT one — the missing area that matters most to a complete picture of THIS person's work. Go strictly by importance, not just "any gap": ask about a central, high-value missing area before a peripheral one.
   - BAN GENERIC FILLER. Do NOT probe surrounding-work areas that apply to almost any job — record-keeping, documentation, "staying up to date", general admin, tool/environment upkeep, generic "compliance" — UNLESS that area is clearly CENTRAL to this specific role. For an individual contributor especially, those are usually marginal; skip them.
   - You have a LIMITED number of questions, so spend them on the highest-value gaps. Once only MINOR or peripheral areas remain, set "done": true and omit the question — do NOT spend a question on something marginal.
3) Otherwise ask ONE question about that most-important gap.

QUESTION RULES (hard):
- OPEN AND NATURAL, NOT REPETITIVE — ask an open question that invites them to describe their work in this area in their own words. The LAST TWO questions you asked are shown below; use a clearly DIFFERENT sentence structure and opener than those, so it doesn't read as a template (don't echo their wording or pattern).
- DON'T PRESUME HEAVY INVOLVEMENT — the gap is a guess, so frame it so that "that's not really part of my job" or "not much" is a perfectly natural answer. AVOID "How do you handle ___?" — it assumes they do a lot of it.
- NON-LEADING — name the AREA in plain words; never the specific task or examples you hope to hear.
- CONVERSATIONAL — ask it the way a warm, curious colleague would in a chat, NOT like a survey: plain everyday language, slightly casual, contractions fine; no stiff "in your role as a [title]" tails or piled-up clinical noun-phrases. One sentence.

Return JSON {"gap":"<the specific missing task area you are targeting, or 'none'>","question":"...","done":<bool>}.` },
      { role: "user", content: `Conversation so far:\n${history.join("\n")}\n\nTasks GATHERED so far:\n${covered.map((t) => `- ${t}`).join("\n") || "(none)"}\n\nAlready-asked questions (do NOT repeat or rephrase):\n${asked.map((q) => `- ${q}`).join("\n")}\n\nLAST TWO questions asked — your question MUST use a clearly DIFFERENT sentence structure than these:\n${asked.slice(-2).map((q) => `- ${q}`).join("\n") || "(none)"}\n\nName the biggest gap in their task inventory and ask about it — or set done if it's well covered.` },
    ],
  });
  try { const j = JSON.parse(r.choices[0].message.content); return { gap: j.gap ?? null, question: j.question ?? null, done: !!j.done }; }
  catch { return { gap: null, question: null, done: true }; }
}

// Post-check: flag questions that open with a yes/no stem, presume the task
// ("How do you handle/manage X"), or contain an example menu ("like/such as X").
function looksBad(q) {
  const s = (q || "").trim();
  return /^(do|does|are|is|was|were|have|has|had|did|can|could|would|will|should)\b/i.test(s)
    || /^how do you (handle|manage|deal with)\b/i.test(s)
    || /\b(like|such as|e\.g\.|for example|including)\b/i.test(s);
}

// Rewrite a flagged question into an open, non-presuming, example-free one.
async function rewriteOpen(question) {
  const r = await chat({
    model: PLANNER_MODEL, temperature: 0.3, response_format: { type: "json_object" },
    messages: [
      { role: "system", content: `Rewrite the interview question so it is OPEN and NON-PRESUMING: NOT answerable yes/no (no "Do/Can/Could/Are/Is/Have/Did" opener); does NOT presume the participant does the task ("How do you handle/manage X" presumes — instead ask what their work involves in that area, so "not much" is a fine answer); and contains NO examples or "like/such as" lists. Keep the same target area, plain and conversational, one sentence. Return JSON {"question":"..."}.` },
      { role: "user", content: `Rewrite: ${question}` },
    ],
  });
  try { return JSON.parse(r.choices[0].message.content).question || question; } catch { return question; }
}

async function runPlannerV2(persona) {
  const byField = Object.fromEntries(QUESTIONS.map((q) => [q.field, q]));
  const history = [], turns = [], covered = [], asked = [];
  // Gated: all topics start uncovered, struck only when criteria met.
  // Ungated: jobTitle seeded; topics struck the moment they're asked (single-touch).
  let remaining = CRITERIA_GATE ? QUESTIONS.map((q) => q.field) : QUESTIONS.slice(1).map((q) => q.field);

  // Criteria-gated strike: drop a topic once the conversation satisfies its criteria.
  // No-op when gating is off (the single-touch strike happens inline in the loop).
  const strike = async () => {
    if (!CRITERIA_GATE) return;
    const cov = await coveredTopics(history.join("\n"), remaining.map((f) => byField[f]));
    remaining = remaining.filter((f) => !cov.includes(f));
  };

  const first = QUESTIONS[0].text;
  let answer = await participant(persona, first, history);
  history.push(`Interviewer: ${first}`, `Participant: ${answer}`); asked.push(first);
  turns.push({ field: QUESTIONS[0].field, question: first, answer, gap: "opening — role & tenure" });
  const [seed] = await Promise.all([newTasksFrom(answer, covered), strike()]);
  covered.push(...seed.tasks);
  const yields = [seed.count];

  let stopReason = "max-turns", emergentDone = false, shadowAsked = false;
  while (turns.length < MAX_TURNS) {
    let question, topic, gap;
    if (remaining.length > 0) {
      // 1) SPINE — criteria-gated topic coverage.
      const plan = await planNext(history, covered, asked, remaining.map((f) => byField[f]));
      if (!plan.question) { stopReason = "no-question"; break; }
      question = plan.question; topic = plan.topic; gap = plan.gap;
    } else if (!emergentDone) {
      // 2) EMERGENT — task-space gap-driven: target a SPECIFIC missing area, until
      //    the role's task inventory is well covered. Reserve the FINAL turn for the
      //    shadow close so it's always asked, even if gaps would otherwise fill the budget.
      if (turns.length >= MAX_TURNS - 1) { emergentDone = true; continue; }
      const eg = await emergentGap(history, covered, asked);
      if ((eg.done || !eg.question) && turns.length >= MIN_TURNS) { emergentDone = true; continue; }
      if (!eg.question) { stopReason = "no-question"; break; }
      question = eg.question; topic = "emergent"; gap = eg.gap;
    } else if (!shadowAsked) {
      // 3) SHADOW — the closing catch-all, asked LAST to sweep up anything still unnamed.
      question = SHADOW_Q; topic = "shadow"; gap = "invisible / unnamed tasks (final catch-all)"; shadowAsked = true;
    } else {
      stopReason = "complete"; break;
    }
    // Post-check: rewrite any presuming / yes-no / example question (the shadow Q is fixed & approved).
    if (question !== SHADOW_Q && looksBad(question)) question = await rewriteOpen(question);
    answer = await participant(persona, question, history);
    history.push(`Interviewer: ${question}`, `Participant: ${answer}`); asked.push(question);
    turns.push({ field: `plan:${topic || "?"}`, question, answer, gap, isFollowUp: true });
    // Update tasks-covered and re-check topic coverage in parallel (off the same answer).
    const [nt] = await Promise.all([newTasksFrom(answer, covered), strike()]);
    covered.push(...nt.tasks);
    yields.push(nt.count);
    // Ungated: single-touch — strike the topic the moment it was asked.
    if (!CRITERIA_GATE && topic && remaining.includes(topic)) {
      remaining = remaining.filter((t) => t !== topic);
    }
    // Novelty saturation during emergent → move to the shadow close (don't break before it).
    if (!emergentDone && turns.length >= MIN_TURNS && remaining.length === 0 && yields.slice(-2).every((y) => y === 0)) {
      emergentDone = true;
    }
  }
  return { turns, stopReason, critPath: CRITERIA_GATE ? 2 : 1 };
}

// ── v3: SparkMe-style EXPECTED-UTILITY planner ────────────────────────────────
// Each turn: propose candidate questions (cover / deepen / gap), ROLL OUT each
// (simulate the answer), score U = expected NEW TASKS (pure task-space novelty —
// no guide-topic bonus), ask the argmax, and STOP when the best candidate's
// expected utility falls below the per-question cost. Breadth must come from the
// candidates' gap reasoning, not from rewarding scaffold-topic coverage.
const UTIL_STOP = 1.0;   // stop once the best candidate's expected utility (new tasks) < this (cost)
// Rollout cadence: in the emergent phase, do the expensive sim-every-candidate rollout
// only every Nth turn; on the others ride the cheap importance-ranked gap (1 call). This
// caps rollout latency/cost — we don't pay a full rollout on every turn.
const ROLLOUT_EVERY = Number(process.env.ROLLOUT_EVERY) || 3;

async function proposeCandidatesV3(history, covered, asked, remainingTopics) {
  const r = await chat({
    model: PLANNER_MODEL, temperature: 0.6, response_format: { type: "json_object" },
    messages: [
      { role: "system", content: `Propose exactly 2 candidate NEXT questions for a work-task interview, each a DIFFERENT strategy:
- COVER: open a still-UNCOVERED guide topic (listed) — set "topic" to its field.
- DEEPEN: drill the richest thread already opened for its concrete sub-tasks — "topic":"deepen".
(A third "GAP" candidate is generated separately, so do NOT propose one here.)
Every question: OPEN (never a yes/no stem — no Do/Can/Could/Are/Is/Have/Did opener); NON-LEADING (name the area, no examples or specific tasks you hope to hear); non-presuming (so "not much" is a fine answer); NOT a repeat or rephrasing of an already-asked question; and CONVERSATIONAL — phrased like a warm, curious colleague chatting, not a survey (plain everyday language, slightly casual, contractions fine; no "in your role as a [title]" tails or piled-up clinical noun-phrases); one sentence.
Return JSON {"candidates":[{"strategy":"COVER|DEEPEN","topic":"<field|deepen>","question":"..."}]}.` },
      { role: "user", content: `Uncovered guide topics (+ what each still needs):\n${remainingTopics.length ? remainingTopics.map((t) => `- ${t.field}: ${t.text} | needs: ${(t.criteria || []).join(" / ")}`).join("\n") : "(none — all covered)"}\n\nConversation so far:\n${history.join("\n")}\n\nAlready-asked (do NOT repeat):\n${asked.map((q) => `- ${q}`).join("\n")}\n\nTasks gathered:\n${covered.map((t) => `- ${t}`).join("\n") || "(none)"}\n\nPropose 3 candidates.` },
    ],
  });
  try { const j = JSON.parse(r.choices[0].message.content); return (j.candidates || []).filter((c) => c && c.question); } catch { return []; }
}

// Prefetch viability: did the rollout's PREDICTED answer match the REAL one closely
// enough that a planner working from the prediction would make the same next decision?
async function answersSimilar(real, predicted) {
  const r = await chat({
    model: SIM_MODEL, temperature: 0, response_format: { type: "json_object" },
    messages: [
      { role: "system", content: `Two answers to the SAME interview question. Do they describe SUBSTANTIALLY THE SAME work/tasks — close enough that an interviewer planning the next question would decide the same either way? Return JSON {"same": true|false}.` },
      { role: "user", content: `REAL ANSWER:\n${real}\n\nPREDICTED ANSWER:\n${predicted}` },
    ],
  });
  try { return !!JSON.parse(r.choices[0].message.content).same; } catch { return false; }
}

async function runPlannerV3(persona) {
  const byField = Object.fromEntries(QUESTIONS.map((q) => [q.field, q]));
  const history = [], turns = [], covered = [], asked = [];
  let remaining = QUESTIONS.map((q) => q.field);
  const strike = async () => {
    const cov = await coveredTopics(history.join("\n"), remaining.map((f) => byField[f]));
    remaining = remaining.filter((f) => !cov.includes(f));
  };

  const first = QUESTIONS[0].text;
  let answer = await participant(persona, first, history);
  history.push(`Interviewer: ${first}`, `Participant: ${answer}`); asked.push(first);
  turns.push({ field: QUESTIONS[0].field, question: first, answer, gap: "opening — role & tenure" });
  const [seed] = await Promise.all([newTasksFrom(answer, covered), strike()]);
  covered.push(...seed.tasks);

  let stopReason = "capped";
  const planTimes = []; // per-turn interviewer latency (propose + rollout + pick), in seconds
  let prefetchHits = 0, prefetchTries = 0; // how often the rollout's predicted answer matched the real one
  let emergentTurn = 0; // counts emergent-phase turns to gate the rollout cadence (ROLLOUT_EVERY)
  const emYields = []; // new-task count per emergent turn; 2 dry turns in a row => gaps exhausted
  // Utility loop — reserve the final turn for the shadow close.
  while (turns.length < MAX_TURNS - 1) {
    const tPlan = Date.now();
    let question, topic, gap, simAns = null;
    const inEmergent = remaining.length === 0;
    if (remaining.length > 0) {
      // SPINE — forced, criteria-gated coverage (no rollout), exactly like v2. This
      // guarantees the spine gets covered, so the argmax can't dodge coverage by deep-
      // drilling a terse respondent's one open thread, and the gap-complete stop can fire.
      const plan = await planNext(history, covered, asked, remaining.map((f) => byField[f]));
      if (!plan.question) { stopReason = "no-question"; break; }
      question = plan.question; topic = plan.topic; gap = `COVER spine · ${plan.gap || ""}`;
    } else {
      // EMERGENT. Always check the importance-ranked gap (cheap, 1 call) — it gives both
      // the gap-complete stop signal and a ready cheap question. Only every ROLLOUT_EVERY
      // turns do we pay the full rollout (sim every DEEPEN candidate vs the gap, argmax
      // novelty); the rest of the time we just ride the gap. So no rollout-every-turn cost.
      const eg = await emergentGap(history, covered, asked);
      // Lean on the gap-complete signal: stop when the judge says we're done, OR when the
      // last two emergent turns surfaced no new tasks (gaps are dry — same conclusion the
      // judge would reach, but it catches the case where it keeps naming ever-thinner gaps).
      const dry = emYields.length >= 2 && emYields.slice(-2).every((y) => y === 0);
      if (turns.length >= MIN_TURNS && (eg.done || dry)) { stopReason = eg.done ? "gap-complete" : "gap-saturated"; break; }
      emergentTurn++;
      if (emergentTurn % ROLLOUT_EVERY === 0) {
        const cd = await proposeCandidatesV3(history, covered, asked, []);
        const cands = cd.filter((c) => c.strategy === "DEEPEN");
        if (eg.question) cands.push({ strategy: "GAP", topic: "gap", question: eg.question });
        if (!cands.length) { stopReason = "no-candidates"; break; }
        const scored = await Promise.all(cands.map(async (c) => {
          const sa = await participant(persona, c.question, history);
          const u = (await newTasksFrom(sa, covered)).count;
          return { ...c, U: u, simAns: sa };
        }));
        scored.sort((a, b) => b.U - a.U);
        const best = scored[0];
        if (best.U < UTIL_STOP && turns.length >= MIN_TURNS) { stopReason = "low-utility"; break; }
        question = best.question; topic = best.topic || best.strategy; simAns = best.simAns;
        gap = `${best.strategy} · U=${best.U.toFixed(1)} (rollout; best of ${scored.map((s) => s.U.toFixed(1)).join("/")})`;
      } else {
        // cheap turn — follow the importance-ranked gap, no rollout
        if (!eg.question) { stopReason = "no-question"; break; }
        question = eg.question; topic = "gap"; gap = `GAP cheap · ${eg.gap || ""}`;
      }
    }
    if (looksBad(question)) question = await rewriteOpen(question);
    planTimes.push((Date.now() - tPlan) / 1000);
    answer = await participant(persona, question, history);
    history.push(`Interviewer: ${question}`, `Participant: ${answer}`); asked.push(question);
    turns.push({ field: `plan:${topic || "?"}`, question, answer, gap, isFollowUp: true });
    // Update tasks + strike; measure prefetch viability only on rollout (emergent) turns.
    await Promise.all([
      newTasksFrom(answer, covered).then((x) => { covered.push(...x.tasks); if (inEmergent) emYields.push(x.count); }),
      strike(),
      (async () => { if (simAns) { prefetchTries++; if (await answersSimilar(answer, simAns)) prefetchHits++; } })(),
    ]);
  }
  // Shadow close — always asked last.
  answer = await participant(persona, SHADOW_Q, history);
  history.push(`Interviewer: ${SHADOW_Q}`, `Participant: ${answer}`); asked.push(SHADOW_Q);
  turns.push({ field: "plan:shadow", question: SHADOW_Q, answer, gap: "invisible / unnamed tasks (final catch-all)", isFollowUp: true });

  const planSec = planTimes.length ? planTimes.reduce((a, b) => a + b, 0) / planTimes.length : 0;
  const prefetchHit = prefetchTries ? prefetchHits / prefetchTries : 0;
  // With prefetch, the ~planSec planning is computed during the participant's typing and
  // is valid whenever the prediction matched (hit). So the latency they actually feel is
  // only the un-hidden part: (1 - hitRate) * planSec (a miss needs a fresh re-plan).
  const effLatency = planSec * (1 - prefetchHit);
  return { turns, stopReason, critPath: 3, planSec, prefetchHit, effLatency };
}

// ── v4: PURE task-space gap-driven — NO spine ────────────────────────────────
// Just emergentGap every turn (pick the biggest missing area of the role's task
// inventory), until no substantive gap remains. Tests whether the spine is needed.
async function runPlannerV4(persona) {
  const history = [], turns = [], covered = [], asked = [];
  const first = QUESTIONS[0].text;
  let answer = await participant(persona, first, history);
  history.push(`Interviewer: ${first}`, `Participant: ${answer}`); asked.push(first);
  turns.push({ field: "open", question: first, answer, gap: "opening — role & tenure" });
  covered.push(...(await newTasksFrom(answer, covered)).tasks);

  let stopReason = "capped";
  while (turns.length < MAX_TURNS - 1) {
    const eg = await emergentGap(history, covered, asked);
    if (eg.done && turns.length >= MIN_TURNS) { stopReason = "gap-complete"; break; }
    if (!eg.question) { stopReason = "no-question"; break; }
    let question = eg.question;
    if (looksBad(question)) question = await rewriteOpen(question);
    answer = await participant(persona, question, history);
    history.push(`Interviewer: ${question}`, `Participant: ${answer}`); asked.push(question);
    turns.push({ field: "plan:gap", question, answer, gap: eg.gap || "", isFollowUp: true });
    covered.push(...(await newTasksFrom(answer, covered)).tasks);
  }
  answer = await participant(persona, SHADOW_Q, history);
  history.push(`Interviewer: ${SHADOW_Q}`, `Participant: ${answer}`); asked.push(SHADOW_Q);
  turns.push({ field: "plan:shadow", question: SHADOW_Q, answer, gap: "final catch-all", isFollowUp: true });
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
- clear: true if the question is CLEAR and easy to understand on first read — concrete, unambiguous, plainly phrased, answerable without re-reading; false if vague ("tell me about your work"), awkward, convoluted, run-on, or jargon-heavy.
Return JSON {"open":<count true>,"leading":<count true>,"redundant":<count true>,"clear":<count true>,"n":<list length>}.` },
      { role: "user", content: qs.map((q, i) => `${i + 1}. ${q}`).join("\n") },
    ],
  });
  try { const j = JSON.parse(r.choices[0].message.content); const n = j.n || qs.length; return { openPct: (j.open ?? 0) / n, leadingPct: (j.leading ?? 0) / n, redundantPct: (j.redundant ?? 0) / n, clearPct: (j.clear ?? 0) / n }; }
  catch { return { openPct: 0, leadingPct: 0, redundantPct: 0, clearPct: 0 }; }
}

async function evalCondition(label, turns, gold) {
  const tasks = await extract(turns, { jobTitle: gold.jobTitle });
  const [cov, quality] = await Promise.all([coverage(gold.gold, tasks), judgeQuestions(turns)]);
  return { label, turns: turns.length, tasks: tasks.length, cov, ...quality };
}

// ── Run (only when invoked directly, not when imported by a viewer) ───────────
if (process.argv[1]?.endsWith("planner_ab.mjs")) {
const rows = [];
for (const persona of selected) {
  console.log(`\n${"═".repeat(74)}\n  ${persona.name}\n${"═".repeat(74)}`);
  const gold = await goldSet(persona);
  console.log(`  role: ${gold.jobTitle} | gold: ${gold.gold.length} | spend so far ${money()}`);

  const base = await runInterview(persona, { quiet: true });
  const v2 = await runPlannerV2(persona);
  const v3 = await runPlannerV3(persona);

  const r = {
    persona: persona.name,
    scripted: await evalCondition("scripted", base.turns, gold),
    v2: await evalCondition("v2-heuristic", v2.turns, gold),
    v3: await evalCondition("v3-utility", v3.turns, gold),
    crit: { scripted: 1, v2: v2.critPath, v3: v3.critPath },
    stop: { v2: v2.stopReason, v3: v3.stopReason },
    v3planSec: v3.planSec, v3prefetch: v3.prefetchHit, v3eff: v3.effLatency,
  };
  rows.push(r);
  const fmt = (c) => `turns=${c.turns} cov=${(c.cov * 100).toFixed(0)}% lead=${(c.leadingPct * 100).toFixed(0)}% redun=${(c.redundantPct * 100).toFixed(0)}% open=${(c.openPct * 100).toFixed(0)}% clear=${(c.clearPct * 100).toFixed(0)}%`;
  console.log(`  SCRIPTED        : ${fmt(r.scripted)}`);
  console.log(`  v2 HEURISTIC    : ${fmt(r.v2)}  (stop ${r.stop.v2})`);
  console.log(`  v3 UTILITY      : ${fmt(r.v3)}  (stop ${r.stop.v3}, ${v3.planSec.toFixed(1)}s/turn raw; prefetch hit ${(v3.prefetchHit * 100).toFixed(0)}% → ${v3.effLatency.toFixed(1)}s effective)`);
}

// ── Summary ─────────────────────────────────────────────────────────────────
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const col = (k, m) => avg(rows.map((r) => r[k][m]));
const p = (x) => `${(x * 100).toFixed(0)}%`;
const conds = [["scripted", "scripted"], ["v2", "v2 heuristic"], ["v3", "v3 utility"]];
console.log(`\n${"═".repeat(74)}\n  SUMMARY (avg over ${rows.length} personas)\n${"═".repeat(74)}`);
console.log("  condition          turns  coverage  tasks/turn  leading  redundant  open  clear  critPath");
for (const [k, name] of conds) {
  console.log(
    `  ${name.padEnd(18)} ${col(k, "turns").toFixed(1).padEnd(6)} ${p(col(k, "cov")).padEnd(9)} ` +
    `${avg(rows.map((r) => r[k].tasks / r[k].turns)).toFixed(2).padEnd(11)} ${p(col(k, "leadingPct")).padEnd(8)} ` +
    `${p(col(k, "redundantPct")).padEnd(10)} ${p(col(k, "openPct")).padEnd(5)} ${p(col(k, "clearPct")).padEnd(6)} ${avg(rows.map((r) => r.crit[k])).toFixed(0)}`,
  );
}
console.log(`\n  v3 latency: ${avg(rows.map((r) => r.v3planSec)).toFixed(1)}s/turn raw  |  prefetch hit ${p(avg(rows.map((r) => r.v3prefetch)))}  →  ${avg(rows.map((r) => r.v3eff)).toFixed(1)}s/turn effective (planning hidden behind the participant's typing when the prediction matches)`);
console.log(`  total spend: ${money()}  |  client calls: ${clientCalls}`);
console.log();
}

export { participant, runPlannerV1, runPlannerV2, runPlannerV3, runPlannerV4, goldSet, extract, coverage, judgeQuestions };
