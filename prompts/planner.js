// SparkMe-style adaptive planner — LIVE adaptation of runPlannerV3 (scripts/planner_ab.mjs).
//
// The harness version runs the whole interview in-process, simulating the participant.
// Live, the participant is a real person answering over HTTP, so the loop is INVERTED:
// the client drives turns and calls plannerStep() once per turn to get the next question.
//
// Structure preserved from v3:
//   - FORCED SPINE: criteria-gated coverage of the guide topics (coveredTopics + planNext),
//     so terse answers still get drilled into concrete tasks.
//   - EMERGENT gap-driving: once the spine is covered, emergentGap targets the most
//     important missing area of the role's task inventory, one open question at a time.
//   - SELF-STOP: ends on gap-complete (judge says done) or gap-saturated (two emergent
//     turns in a row surface no new tasks), then asks the shadow catch-all last.
//
// DROPPED (evaluated, then removed): the per-candidate expected-utility ROLLOUT and the
// speculative PREFETCH. Both hinge on PREDICTING the participant's answer, which an A/B
// showed is only ~50-80% reliable (worst on terse respondents). Rollout gave no quality
// gain over pure emergentGap while adding latency and over-deepening on terse answers;
// prefetch was wasted compute on the same misses. So the emergent phase is just
// emergentGap — one importance-ranked open question per turn, with the self-stop.
import { readFileSync } from 'node:fs';
import {
  NEW_TASKS_SYSTEM,
  COVERED_TOPICS_SYSTEM,
  PLAN_NEXT_SYSTEM,
  STRIKE_AND_GENERATE_SYSTEM,
  EMERGENT_GAP_SYSTEM,
  REWRITE_OPEN_SYSTEM,
} from './planner/prompts.js';

const GUIDE = JSON.parse(readFileSync(new URL('./interview-guide.json', import.meta.url)));

// Spine topics, with the depth-first stakeholders variant applied (the harness ran
// REVISED_STAKEHOLDERS=1 — it extracts relational tasks instead of collecting names).
const QUESTIONS = GUIDE.questions.map((q) =>
  q.field === 'stakeholders' && GUIDE.stakeholdersRevised
    ? { ...q, ...GUIDE.stakeholdersRevised }
    : q,
);
const BY_FIELD = Object.fromEntries(QUESTIONS.map((q) => [q.field, q]));
const SPINE_FIELDS = QUESTIONS.map((q) => q.field);
// The proven closing catch-all — asked LAST to sweep up invisible/relational tasks.
const SHADOW_Q =
  BY_FIELD.stakeholders?.closingQuestion ||
  'Last one: if someone shadowed you for two weeks, what tasks would they see that we haven’t named yet?';

const PLANNER_MODEL = process.env.PLANNER_MODEL || 'gpt-4o';
const COUNT_MODEL = process.env.SMALL_MODEL || 'gpt-4o-mini';
// Question budget (incl. shadow). Hard-capped at 20 — even if the env var is set
// higher — so the interview can never run past 20 turns. Enforced below: at the
// budget the planner forces the shadow catch-all and ends.
const MAX_TURNS = Math.min(20, Number(process.env.PLANNER_MAX_TURNS) || 20);
const MIN_TURNS = Number(process.env.PLANNER_MIN_TURNS) || 5;
// Merge strike (coverage judge) + generate (next question) into ONE call on spine turns,
// instead of two sequential gpt-4o calls. Default ALL spine turns (high cap): the A/B
// showed merging cuts leading/redundant questions and latency with no coverage cost.
// Set PLANNER_MERGE_FIRST_N=0 to revert to fully separate; a small N to merge only the
// first few. (Emergent turns always use emergentGap, never this.)
const MERGE_FIRST_N = Number(process.env.PLANNER_MERGE_FIRST_N ?? 999);

// ── per-call LLM helpers (ported verbatim from scripts/planner_ab.mjs) ──────────

async function jsonChat(client, args) {
  const r = await client.chat.completions.create({ response_format: { type: 'json_object' }, ...args });
  try { return JSON.parse(r.choices[0].message.content); } catch { return null; }
}

// New concrete recurring tasks an answer adds beyond `covered`.
async function newTasksFrom(client, answer, covered) {
  const j = await jsonChat(client, {
    model: COUNT_MODEL, temperature: 0,
    messages: [
      { role: 'system', content: NEW_TASKS_SYSTEM },
      { role: 'user', content: `COVERED:\n${covered.map((t) => `- ${t}`).join('\n') || '(none)'}\n\nANSWER:\n${answer}\n\nList only the genuinely new tasks.` },
    ],
  });
  const tasks = (j?.tasks || []).filter((t) => typeof t === 'string' && t.trim());
  return { count: tasks.length, tasks };
}

// Which of the given guide TOPICS does the conversation now ADEQUATELY satisfy?
async function coveredTopics(client, conversation, topics) {
  if (!topics.length) return [];
  const j = await jsonChat(client, {
    model: PLANNER_MODEL, temperature: 0,
    messages: [
      { role: 'system', content: COVERED_TOPICS_SYSTEM },
      { role: 'user', content: `CONVERSATION:\n${conversation || '(none yet)'}\n\nTOPICS:\n${topics.map((t) => `- ${t.field}: ${t.text}\n   criteria: ${(t.criteria || []).join(' | ')}`).join('\n')}` },
    ],
  });
  return Array.isArray(j?.covered) ? j.covered : [];
}

// SPINE generator: advance the most valuable uncovered guide topic toward its criteria.
async function planNext(client, history, covered, asked, remainingTopics) {
  const j = await jsonChat(client, {
    model: PLANNER_MODEL, temperature: 0.4,
    messages: [
      { role: 'system', content: PLAN_NEXT_SYSTEM },
      { role: 'user', content: `UNCOVERED guide topics — and what each STILL NEEDS:\n${remainingTopics.length ? remainingTopics.map((t) => `- ${t.field}: ${t.text}\n   still needs: ${(t.criteria || []).join(' | ')}`).join('\n') : '(none — all guide topics covered; probe emergent tasks)'}\n\nConversation so far:\n${history.join('\n') || '(none yet)'}\n\nAlready-asked questions (do NOT repeat or rephrase):\n${asked.map((q) => `- ${q}`).join('\n') || '(none)'}\n\nTasks already covered:\n${covered.map((t) => `- ${t}`).join('\n') || '(none)'}\n\nAdvance the most valuable uncovered topic toward what it still needs (or probe emergent tasks if all are covered) and ask the single best next question.` },
    ],
  });
  return { gap: j?.gap ?? null, topic: j?.topic ?? null, question: j?.question ?? null, done: !!j?.done };
}

// MERGED strike + generate (one call) for the early spine turns: judge which topics are
// now covered AND write the next question, instead of two sequential gpt-4o calls. Same
// coverage rubric as coveredTopics and same question rules as planNext, fused.
async function strikeAndGenerate(client, history, covered, asked, remainingTopics) {
  const j = await jsonChat(client, {
    model: PLANNER_MODEL, temperature: 0.4,
    messages: [
      { role: 'system', content: STRIKE_AND_GENERATE_SYSTEM },
      { role: 'user', content: `TOPICS — field: text, with criteria:\n${remainingTopics.map((t) => `- ${t.field}: ${t.text}\n   criteria: ${(t.criteria || []).join(' | ')}`).join('\n')}\n\nConversation so far:\n${history.join('\n')}\n\nAlready-asked questions (do NOT repeat or rephrase):\n${asked.map((q) => `- ${q}`).join('\n') || '(none)'}\n\nTasks already covered:\n${covered.map((t) => `- ${t}`).join('\n') || '(none)'}\n\nJudge coverage, then advance the most valuable uncovered topic with the single best next question.` },
    ],
  });
  return { covered: Array.isArray(j?.covered) ? j.covered : [], gap: j?.gap ?? null, topic: j?.topic ?? null, question: j?.question ?? null, done: !!j?.done };
}

// EMERGENT phase: picture the role's full task inventory, diff against what's gathered,
// target the most IMPORTANT missing area; set done when only marginal areas remain.
// Verbatim port of runPlannerV3's emergentGap (scripts/planner_ab.mjs).
async function emergentGap(client, history, covered, asked) {
  const j = await jsonChat(client, {
    model: PLANNER_MODEL, temperature: 0.4,
    messages: [
      { role: 'system', content: EMERGENT_GAP_SYSTEM },
      { role: 'user', content: `Conversation so far:\n${history.join('\n')}\n\nTasks GATHERED so far:\n${covered.map((t) => `- ${t}`).join('\n') || '(none)'}\n\nAlready-asked questions (do NOT repeat or rephrase):\n${asked.map((q) => `- ${q}`).join('\n')}\n\nLAST TWO questions asked — your question MUST use a clearly DIFFERENT sentence structure than these:\n${asked.slice(-2).map((q) => `- ${q}`).join('\n') || '(none)'}\n\nName the biggest gap in their task inventory and ask about it — or set done if it's well covered.` },
    ],
  });
  return { gap: j?.gap ?? null, question: j?.question ?? null, done: j == null ? true : !!j?.done };
}

// Post-check + rewrite for closed/presuming/example-laden phrasings.
function looksBad(q) {
  const s = (q || '').trim();
  return /^(do|does|are|is|was|were|have|has|had|did|can|could|would|will|should)\b/i.test(s)
    || /^how do you (handle|manage|deal with)\b/i.test(s)
    || /\b(like|such as|e\.g\.|for example|including)\b/i.test(s);
}

async function rewriteOpen(client, question) {
  const j = await jsonChat(client, {
    model: PLANNER_MODEL, temperature: 0.3,
    messages: [
      { role: 'system', content: REWRITE_OPEN_SYSTEM },
      { role: 'user', content: `Rewrite: ${question}` },
    ],
  });
  return j?.question || question;
}

// ── one planner turn ───────────────────────────────────────────────────────────
// Given the conversation so far (turns) and the planner state from the previous call,
// process the latest answer (extract tasks, strike covered topics) and decide the next
// question. Stateless server: the caller passes `state` back each turn.
//
//   turns:  [{ question, answer }]  — every Q/A asked so far (the latest is unprocessed)
//   state:  opaque blob from the previous call's response (null/omitted on the first call)
// returns { question, phase, gap, done, stopReason, state }
//   - first call (turns empty): returns the opening question, no answer processed yet
//   - done=true: interview is over; question is null (the shadow was the last question)
export async function plannerStep(client, { turns = [], state = null } = {}) {
  // FIRST CALL — hand back the opening question and seed the state.
  if (!turns.length) {
    const opening = QUESTIONS[0].text;
    return {
      question: opening, phase: 'open', gap: 'opening — role & field', done: false, stopReason: null,
      state: { covered: [], remaining: [...SPINE_FIELDS], emYields: [], lastPhase: 'open', stopReason: null },
    };
  }

  const st = state || { covered: [], remaining: [...SPINE_FIELDS], emYields: [], lastPhase: 'open' };
  let { covered, remaining, emYields, lastPhase } = st;
  const history = turns.flatMap((t) => [`Interviewer: ${t.question}`, `Participant: ${t.answer}`]);
  const asked = turns.map((t) => t.question);
  const lastAnswer = turns[turns.length - 1].answer;

  // The shadow catch-all was the last question we asked → the interview is complete.
  if (lastPhase === 'shadow') {
    const post = await newTasksFrom(client, lastAnswer, covered);
    covered = [...covered, ...post.tasks];
    return { question: null, phase: 'done', gap: null, done: true, stopReason: st.stopReason || 'shadow-complete', state: { ...st, covered } };
  }

  const n = turns.length; // questions asked & answered so far
  // First few SPINE turns: one merged call (strike + generate). Later, or in emergent,
  // keep strike and generate separate. (lastPhase 'open' or 'spine' = still on the spine.)
  const useMerge = n <= MERGE_FIRST_N && remaining.length > 0 && lastPhase !== 'emergent' && lastPhase !== 'shadow';

  // 1) PROCESS the latest answer: extract new tasks, re-judge spine coverage. On a merge
  // turn the coverage judge and the next question come from ONE call (`merged`).
  let post, coveredFields, merged = null;
  if (useMerge) {
    [post, merged] = await Promise.all([
      newTasksFrom(client, lastAnswer, covered),
      strikeAndGenerate(client, history, covered, asked, remaining.map((f) => BY_FIELD[f])),
    ]);
    coveredFields = merged.covered;
  } else {
    [post, coveredFields] = await Promise.all([
      newTasksFrom(client, lastAnswer, covered),
      coveredTopics(client, history.join('\n'), remaining.map((f) => BY_FIELD[f])),
    ]);
  }
  covered = [...covered, ...post.tasks];
  remaining = remaining.filter((f) => !coveredFields.includes(f));
  if (lastPhase === 'emergent') emYields = [...emYields, post.count];

  const newState = (extra) => ({ covered, remaining, emYields, lastPhase, stopReason: st.stopReason || null, ...extra });

  // Out of budget — go straight to the shadow close.
  const askShadow = () => ({
    question: SHADOW_Q, phase: 'shadow', gap: 'final catch-all', done: false,
    stopReason: st.stopReason || 'capped',
    state: newState({ lastPhase: 'shadow', stopReason: st.stopReason || 'capped' }),
  });
  if (n >= MAX_TURNS - 1) return askShadow();

  // 2) SPINE — forced criteria-gated coverage (no rollout), exactly like v3's spine phase.
  // v3: if the planner declines to ask, it ends (→ shadow), it does NOT fall through.
  // STATIC topics (precisely-worded reflective questions) are asked VERBATIM — never
  // rephrased — since regeneration only makes them awkward.
  const staticText = (topic) => (topic && BY_FIELD[topic]?.static) ? BY_FIELD[topic].text : null;
  if (remaining.length > 0) {
    // On a merge turn the next question is already in hand (no extra planNext call).
    if (merged && merged.question) {
      const stat = staticText(merged.topic);
      let question = stat || merged.question;
      if (!stat && looksBad(question)) question = await rewriteOpen(client, question);
      return { question, phase: 'spine', gap: merged.gap || '', done: false, stopReason: null, state: newState({ lastPhase: 'spine' }) };
    }
    const plan = await planNext(client, history, covered, asked, remaining.map((f) => BY_FIELD[f]));
    if (!plan.question) {
      return { question: SHADOW_Q, phase: 'shadow', gap: 'final catch-all', done: false, stopReason: 'no-question', state: newState({ lastPhase: 'shadow', stopReason: 'no-question' }) };
    }
    const stat = staticText(plan.topic);
    let question = stat || plan.question;
    if (!stat && looksBad(question)) question = await rewriteOpen(client, question);
    return { question, phase: 'spine', gap: plan.gap || '', done: false, stopReason: null, state: newState({ lastPhase: 'spine' }) };
  }

  // 3) EMERGENT — importance-ranked gap-driving. emergentGap names the single most
  // important missing area and asks one open question about it; self-stop on gap-complete
  // (judge done) or gap-saturated (two emergent turns surfaced no new tasks).
  const eg = await emergentGap(client, history, covered, asked);
  const dry = emYields.length >= 2 && emYields.slice(-2).every((y) => y === 0);
  if (n >= MIN_TURNS && (eg.done || dry)) {
    const stopReason = eg.done ? 'gap-complete' : 'gap-saturated';
    return { question: SHADOW_Q, phase: 'shadow', gap: 'final catch-all', done: false, stopReason, state: newState({ lastPhase: 'shadow', stopReason }) };
  }
  if (!eg.question) return askShadow();
  let question = eg.question;
  if (looksBad(question)) question = await rewriteOpen(client, question);
  return { question, phase: 'emergent', gap: eg.gap || '', done: false, stopReason: null, state: newState({ lastPhase: 'emergent' }) };
}
