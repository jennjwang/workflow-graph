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
      { role: 'system', content: `Count the NEW, concrete, recurring WORK TASKS an interview answer reveals that are NOT already in the covered list (compare meaning, not wording; ignore vague/non-task statements). Return JSON {"tasks":["..."],"count":<int>}.` },
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
      { role: 'system', content: `You judge interview COVERAGE. For each TOPIC, decide whether the conversation now ADEQUATELY satisfies that topic's criteria. Be strict — a topic is covered only if its criteria are genuinely MET by what the participant actually said, not merely touched on or named in passing. Return JSON {"covered":["<field of each adequately-covered topic>"]}.` },
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
      { role: 'system', content: `You are an expert interviewer building a COMPLETE picture of someone's recurring WORK TASKS in as few turns as possible. Each turn, advance the BIGGEST COVERAGE GAP:

1) PRIORITIZE UNCOVERED GUIDE TOPICS — the uncovered topics are listed with WHAT EACH STILL NEEDS (its criteria). Pick the most valuable uncovered topic and ask a question that moves it toward what it still needs. Keep working the SAME topic across turns until its criteria are met — don't touch it once and move on.
2) DEPTH OVER BREADTH WITHIN A TOPIC — if a topic's criteria call for the concrete sub-tasks of a dominant activity, drill into the distinct KINDS of work inside it rather than asking a shallow one-liner.
3) Only once all guide topics are genuinely covered, probe EMERGENT role tasks not yet surfaced — but ONLY while there's a genuinely valuable, non-redundant area left. END the interview as soon as it's complete; do NOT pad it with marginal or repetitive questions.
ASK ONE QUESTION that gets them to describe the tasks themselves — UNLESS you're done (see ENDING).

ENDING — set "done": true once every guide topic is covered AND you see no further genuinely valuable, non-redundant area of their work to ask about. When done, you may omit the question. Don't keep asking just to fill turns.

QUESTION RULES (hard):
- OPEN-ENDED — must invite them to describe their work in their own words and must NOT be answerable yes/no. Use any natural open phrasing you like (vary it freely), but NEVER a closed / yes-no stem ("Do you", "Can you", "Could you", "Are there", "Is there", "Have you", "Did you", "Would you say", "Is it") — those force a yes/no and lead. This applies to the WHOLE question, not just its first word: do NOT bury a yes/no clause later in the sentence either (e.g. "When you build it, do you spend much time debugging?" — the "do you spend…" makes it yes/no and leading). The entire question must be answerable only by describing. Prefer the imperative ("Walk me through…") over "Can you walk me through…".
- NON-LEADING — never name or hint at a specific task/answer you hope to hear, and DO NOT put examples or a menu of possible answers in the question (examples lead the witness). For hands-on/clinical/manual roles especially: ask about the AREA in plain words; do NOT name domain-specific procedures or tasks.
- NOT REPETITIVE — never repeat or rephrase any already-asked question, AND never ask about a task or activity the participant has ALREADY described anywhere in the conversation (even if it came up under a different question). Re-read the full transcript and the tasks already covered first; only open GENUINELY NEW ground or push meaningfully deeper.
- CONVERSATIONAL — ask it the way a warm, curious colleague actually would in a chat, NOT like a survey or interrogation: plain everyday language, a little casual is good, contractions fine. Do NOT tack "in your role as a [job title]" onto questions, and don't pile up clinical noun-phrases ("outputs or deliverables you produce or maintain"). One sentence.

FINAL CHECK before you answer — re-read your question and REWRITE it if it: names or hints at any specific task, contains examples or a menu of possible answers ("like X, Y, or Z"), could be answered yes/no (whether it OPENS with Do/Can/Could/Are/Is/Have/Did/Would OR buries such a clause mid-sentence), or echoes an earlier question or anything already described. Only return a question that passes all four. Phrasing is otherwise free — vary it naturally.

Return JSON {"gap":"<the specific uncovered area of THEIR work you are targeting this turn>","topic":"<the guide-topic field this advances, or 'emergent'>","question":"...","done":<bool>}. Return a question unless done is true.` },
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
      { role: 'system', content: `You run a work-task interview. Do BOTH of these in ONE step:

PART A — COVERAGE: For each TOPIC listed, decide whether the conversation now ADEQUATELY satisfies that topic's criteria. Be strict — covered only if the criteria are genuinely MET by what the participant actually said, not merely touched on in passing.

PART B — NEXT QUESTION: Among the topics NOT yet adequately covered, pick the MOST VALUABLE and ask the single best next question to advance it toward what its criteria still need. Keep working the same topic across turns until it's covered; drill into concrete sub-tasks rather than asking a shallow one-liner.

QUESTION RULES (hard):
- OPEN-ENDED — invite them to describe their work in their own words; NEVER a yes/no stem ("Do you", "Can you", "Could you", "Are there", "Is there", "Have you", "Did you", "Would you") — and not buried mid-sentence either ("…, do you spend much time on X?"). The whole question must be answerable only by describing, never yes/no. Prefer the imperative ("Walk me through…").
- NON-LEADING — never name or hint at a specific task/answer you hope to hear; no examples or menus ("like X, Y, or Z").
- NOT REPETITIVE — never repeat or rephrase an already-asked question (listed below), AND never ask about a task or activity the participant has ALREADY described anywhere in the conversation (even under a different question). Only open genuinely new ground or push meaningfully deeper.
- CONVERSATIONAL — like a warm, curious colleague chatting; plain everyday language, contractions fine; do NOT tack "in your role as a [job title]" or "as a [role]" onto the question. One sentence.

Return JSON {"covered":["<field of each adequately-covered topic>"],"gap":"<the uncovered area you target this turn>","topic":"<the field this question advances>","question":"...","done":<bool>}. Set done true only if EVERY topic is already covered.` },
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
      { role: 'system', content: `You are finishing a work-task interview. From the conversation, infer the participant's ROLE and what they've already described, then:
0) DECOMPOSE THE CORE FIRST. Before hunting for entirely new areas, look at the CENTRAL activities they ALREADY named. If a dominant one is still just a bare label — "write code", "design experiments", "see patients", "write papers" — with none of its distinct sub-tasks surfaced, that under-decomposed core IS the biggest gap. A dominant activity is worth SEVERAL tasks, not one: ask them to break it into the different KINDS of work it involves (e.g. "writing code" for a researcher → implementing models, running experiments, debugging, analyzing results, reviewing others' code). Drill the richest bare-label activity this way before moving on to peripheral missing areas — a thin, single-task core is a worse gap than a missing minor area.
1) Then think about the recurring tasks someone in THIS exact role does, and which matter MOST — the areas most CENTRAL, frequent, or consequential to the role.
2) DIFF against the tasks ALREADY GATHERED (below). Among the areas NOT yet surfaced (or named only as a bare label, per step 0), target the MOST IMPORTANT one — the missing or under-decomposed area that matters most to a complete picture of THIS person's work. Go strictly by importance, not just "any gap": ask about a central, high-value area before a peripheral one.
   - BAN GENERIC FILLER. Do NOT probe surrounding-work areas that apply to almost any job — record-keeping, documentation, "staying up to date", general admin, tool/environment upkeep, generic "compliance" — UNLESS that area is clearly CENTRAL to this specific role. For an individual contributor especially, those are usually marginal; skip them.
   - You have a LIMITED number of questions, so spend them on the highest-value gaps. Once only MINOR or peripheral areas remain, set "done": true and omit the question — do NOT spend a question on something marginal.
3) Otherwise ask ONE question about that most-important gap.

QUESTION RULES (hard):
- OPEN AND NATURAL, NOT REPETITIVE — ask an open question that invites them to describe their work in this area in their own words. The LAST TWO questions you asked are shown below; use a clearly DIFFERENT sentence structure and opener than those, so it doesn't read as a template (don't echo their wording or pattern).
- DON'T PRESUME HEAVY INVOLVEMENT — the gap is a guess, so frame it so that "that's not really part of my job" or "not much" is a perfectly natural answer. AVOID "How do you handle ___?" — it assumes they do a lot of it.
- NON-LEADING — name the AREA in plain words; never the specific task or examples you hope to hear.
- CONVERSATIONAL — ask it the way a warm, curious colleague would in a chat, NOT like a survey: plain everyday language, slightly casual, contractions fine; no stiff "in your role as a [title]" tails or piled-up clinical noun-phrases. One sentence.

Return JSON {"gap":"<the specific missing task area you are targeting, or 'none'>","question":"...","done":<bool>}.` },
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
      { role: 'system', content: `Rewrite the interview question so it is OPEN and NON-PRESUMING: NOT answerable yes/no (no "Do/Can/Could/Are/Is/Have/Did" opener); does NOT presume the participant does the task ("How do you handle/manage X" presumes — instead ask what their work involves in that area, so "not much" is a fine answer); and contains NO examples or "like/such as" lists. Keep the same target area, plain and conversational, one sentence. Return JSON {"question":"..."}.` },
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
