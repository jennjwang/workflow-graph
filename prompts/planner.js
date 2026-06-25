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
// DROPPED live: the per-candidate expected-utility ROLLOUT. It simulates the participant's
// answer to score candidate questions — impossible for a real person, and it was the
// slow part (it only ran every ROLLOUT_EVERY turns and prefetch-hit ~0). On the cheap
// turns v3 already just rode emergentGap, which is exactly what we do here every turn.
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
const MAX_TURNS = Number(process.env.PLANNER_MAX_TURNS) || 15; // question budget (incl. shadow)
const MIN_TURNS = Number(process.env.PLANNER_MIN_TURNS) || 5;
// Merge strike (coverage judge) + generate (next question) into ONE call on spine turns,
// instead of two sequential gpt-4o calls. Default ALL spine turns (high cap): the A/B
// showed merging cuts leading/redundant questions and latency with no coverage cost.
// Set PLANNER_MERGE_FIRST_N=0 to revert to fully separate; a small N to merge only the
// first few. (Emergent turns always use emergentGap, never this.)
const MERGE_FIRST_N = Number(process.env.PLANNER_MERGE_FIRST_N ?? 999);
// Rollout cadence: every Nth emergent turn, do the simulated per-candidate rollout
// (predict the participant's answer to each candidate, score by new tasks, argmax);
// other emergent turns ride the cheap importance-ranked gap. 0 disables the rollout.
const ROLLOUT_EVERY = Number(process.env.PLANNER_ROLLOUT_EVERY ?? 0); // TEMP: rollout OFF (v3 default is 3) — isolating cheap-turn latency
const UTIL_STOP = Number(process.env.PLANNER_UTIL_STOP ?? 1.0); // stop if best candidate's expected new tasks < this

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
- OPEN-ENDED — must invite them to describe their work in their own words and must NOT be answerable yes/no. Use any natural open phrasing you like (vary it freely), but NEVER a closed / yes-no stem ("Do you", "Can you", "Could you", "Are there", "Is there", "Have you", "Did you", "Would you say", "Is it") — those force a yes/no and lead. Prefer the imperative ("Walk me through…") over "Can you walk me through…".
- NON-LEADING — never name or hint at a specific task/answer you hope to hear, and DO NOT put examples or a menu of possible answers in the question (examples lead the witness). For hands-on/clinical/manual roles especially: ask about the AREA in plain words; do NOT name domain-specific procedures or tasks.
- NOT REPETITIVE — never repeat or rephrase any already-asked question; open a different thread or push deeper than the last.
- CONVERSATIONAL — ask it the way a warm, curious colleague actually would in a chat, NOT like a survey or interrogation: plain everyday language, a little casual is good, contractions fine. Do NOT tack "in your role as a [job title]" onto questions, and don't pile up clinical noun-phrases ("outputs or deliverables you produce or maintain"). One sentence.

FINAL CHECK before you answer — re-read your question and REWRITE it if it: names or hints at any specific task, contains examples or a menu of possible answers ("like X, Y, or Z"), could be answered yes/no (e.g. opens with Do/Can/Could/Are/Is/Have/Did/Would), or echoes an earlier question. Only return a question that passes all four. Phrasing is otherwise free — vary it naturally.

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
- OPEN-ENDED — invite them to describe their work in their own words; NEVER a yes/no stem ("Do you", "Can you", "Could you", "Are there", "Is there", "Have you", "Did you", "Would you"). Prefer the imperative ("Walk me through…").
- NON-LEADING — never name or hint at a specific task/answer you hope to hear; no examples or menus ("like X, Y, or Z").
- NOT REPETITIVE — never repeat or rephrase an already-asked question (listed below); open a different thread or push deeper.
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

// Propose 2 candidate next questions (COVER + DEEPEN) for the rollout to score against
// the importance-ranked GAP. Verbatim port of runPlannerV3's proposeCandidatesV3; the
// emergent rollout calls it with no uncovered topics and keeps only the DEEPEN ones.
async function proposeCandidatesV3(client, history, covered, asked, remainingTopics) {
  const j = await jsonChat(client, {
    model: PLANNER_MODEL, temperature: 0.6,
    messages: [
      { role: 'system', content: `Propose exactly 2 candidate NEXT questions for a work-task interview, each a DIFFERENT strategy:
- COVER: open a still-UNCOVERED guide topic (listed) — set "topic" to its field.
- DEEPEN: drill the richest thread already opened for its concrete sub-tasks — "topic":"deepen".
(A third "GAP" candidate is generated separately, so do NOT propose one here.)
Every question: OPEN (never a yes/no stem — no Do/Can/Could/Are/Is/Have/Did opener); NON-LEADING (name the area, no examples or specific tasks you hope to hear); non-presuming (so "not much" is a fine answer); NOT a repeat or rephrasing of an already-asked question; and CONVERSATIONAL — phrased like a warm, curious colleague chatting, not a survey (plain everyday language, slightly casual, contractions fine; no "in your role as a [title]" tails or piled-up clinical noun-phrases); one sentence.
Return JSON {"candidates":[{"strategy":"COVER|DEEPEN","topic":"<field|deepen>","question":"..."}]}.` },
      { role: 'user', content: `Uncovered guide topics (+ what each still needs):\n${remainingTopics.length ? remainingTopics.map((t) => `- ${t.field}: ${t.text} | needs: ${(t.criteria || []).join(' / ')}`).join('\n') : '(none — all covered)'}\n\nConversation so far:\n${history.join('\n')}\n\nAlready-asked (do NOT repeat):\n${asked.map((q) => `- ${q}`).join('\n')}\n\nTasks gathered:\n${covered.map((t) => `- ${t}`).join('\n') || '(none)'}\n\nPropose the candidates.` },
    ],
  });
  return (Array.isArray(j?.candidates) ? j.candidates : []).filter((c) => c && c.question);
}

// Simulated participant: PREDICT how THIS person would answer a candidate question,
// inferring their role and (terse vs verbose) answering style from the transcript.
// Stands in for the real participant during the rollout (we can't ask them N
// hypothetical questions). Kept short/realistic so the new-task count is meaningful.
async function predictAnswer(client, history, question) {
  const r = await client.chat.completions.create({
    model: COUNT_MODEL, temperature: 0.3,
    messages: [
      { role: 'system', content: `From the interview transcript, infer the participant's ROLE and their answering STYLE (terse vs detailed — match how long their real answers run). Then predict, in first person and in character, how THEY would most likely answer the interviewer's next question. Keep it realistic and as SHORT as their real answers tend to be — don't invent elaborate detail a terse answerer wouldn't give. Output ONLY the predicted reply text.` },
      { role: 'user', content: `Transcript so far:\n${history.join('\n')}\n\nInterviewer: ${question}\n\nPredicted answer:` },
    ],
  });
  return (r.choices[0].message.content || '').trim();
}

// Are two answers to the same question substantially the same work — close enough that
// the planner would make the same next decision either way? Gate for serving a prefetch.
async function answersSimilar(client, real, predicted) {
  const j = await jsonChat(client, {
    model: COUNT_MODEL, temperature: 0,
    messages: [
      { role: 'system', content: `Two answers to the SAME interview question. Do they describe SUBSTANTIALLY THE SAME work/tasks — close enough that an interviewer planning the next question would decide the same either way? Return JSON {"same": true|false}.` },
      { role: 'user', content: `REAL ANSWER:\n${real}\n\nPREDICTED ANSWER:\n${predicted}` },
    ],
  });
  return !!j?.same;
}

// SPECULATIVE PREFETCH — runs while the participant is typing. Predict their answer to
// the question now on screen, then compute the NEXT planner step from that prediction.
// The client holds the result; on submit, plannerNextOrPrefetch validates the real
// answer against the prediction and serves this precomputed step instantly on a match.
export async function plannerPrefetch(client, { turns = [], state = null, currentQuestion } = {}) {
  if (!currentQuestion) return null;
  const history = turns.flatMap((t) => [`Interviewer: ${t.question}`, `Participant: ${t.answer}`]);
  const predictedAnswer = await predictAnswer(client, history, currentQuestion);
  const speculativeTurns = [...turns, { question: currentQuestion, answer: predictedAnswer }];
  const result = await plannerStep(client, { turns: speculativeTurns, state });
  return { predictedAnswer, result };
}

// Validate-or-recompute. If a prefetch is supplied and the real answer matches its
// prediction, serve the precomputed step (no LLM planning — only the cheap similarity
// check). Otherwise fall back to a fresh plannerStep. plannerStep itself is untouched.
export async function plannerNextOrPrefetch(client, { turns = [], state = null, prefetch = null } = {}) {
  if (prefetch && prefetch.predictedAnswer != null && prefetch.result && turns.length) {
    const realAnswer = turns[turns.length - 1].answer;
    if (await answersSimilar(client, realAnswer, prefetch.predictedAnswer)) {
      return { ...prefetch.result, servedFromPrefetch: true };
    }
  }
  return plannerStep(client, { turns, state });
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
      state: { covered: [], remaining: [...SPINE_FIELDS], emergentTurn: 0, emYields: [], lastPhase: 'open', stopReason: null },
    };
  }

  const st = state || { covered: [], remaining: [...SPINE_FIELDS], emergentTurn: 0, emYields: [], lastPhase: 'open' };
  let { covered, remaining, emergentTurn, emYields, lastPhase } = st;
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

  const newState = (extra) => ({ covered, remaining, emergentTurn, emYields, lastPhase, stopReason: st.stopReason || null, ...extra });

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

  // 3) EMERGENT — exactly v3: emergentGap, self-stop, then cadence rollout. The ONE
  // deviation from the harness: the rollout PREDICTS the participant's answer to each
  // candidate (predictAnswer) instead of simulating a known persona — live we have no
  // persona to simulate, so we infer the likely answer from the transcript.
  const eg = await emergentGap(client, history, covered, asked);
  const dry = emYields.length >= 2 && emYields.slice(-2).every((y) => y === 0);
  if (n >= MIN_TURNS && (eg.done || dry)) {
    const stopReason = eg.done ? 'gap-complete' : 'gap-saturated';
    return { question: SHADOW_Q, phase: 'shadow', gap: 'final catch-all', done: false, stopReason, state: newState({ lastPhase: 'shadow', stopReason }) };
  }
  emergentTurn += 1;

  let question = null, gap = `GAP cheap · ${eg.gap || ''}`;
  if (ROLLOUT_EVERY > 0 && emergentTurn % ROLLOUT_EVERY === 0) {
    const cd = await proposeCandidatesV3(client, history, covered, asked, []);
    const cands = cd.filter((c) => c.strategy === 'DEEPEN');
    if (eg.question) cands.push({ strategy: 'GAP', topic: 'gap', question: eg.question });
    if (cands.length) {
      const scored = await Promise.all(cands.map(async (c) => {
        const sa = await predictAnswer(client, history, c.question);
        const u = (await newTasksFrom(client, sa, covered)).count;
        return { ...c, U: u };
      }));
      scored.sort((a, b) => b.U - a.U);
      const best = scored[0];
      if (best.U < UTIL_STOP && n >= MIN_TURNS) {
        return { question: SHADOW_Q, phase: 'shadow', gap: 'final catch-all', done: false, stopReason: 'low-utility', state: newState({ emergentTurn, lastPhase: 'shadow', stopReason: 'low-utility' }) };
      }
      question = best.question;
      gap = `${best.strategy} · rollout U=${best.U} (of ${scored.map((s) => s.U).join('/')})`;
    }
  }
  // Cheap path (non-rollout turn, or rollout produced no candidates): ride the gap.
  if (!question) {
    if (!eg.question) return askShadow();
    question = eg.question;
  }
  if (looksBad(question)) question = await rewriteOpen(client, question);
  return {
    question, phase: 'emergent', gap, done: false, stopReason: null,
    state: newState({ emergentTurn, lastPhase: 'emergent' }),
  };
}
