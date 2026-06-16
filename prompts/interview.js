// Background-interview prompts. These build the chat messages for the two
// interview endpoints in server.js:
//   - /api/evaluate-answer    (coverage judgment + conversational follow-ups)
//   - /api/interview-question (reword a canonical question naturally)
// Kept here so the interview wording lives in one place, separate from server
// plumbing and from the task-generation prompts in task-generator.js.

// ── /api/evaluate-answer ──────────────────────────────────────────────────────

function styleRulesFor(evaluationStyle) {
  return evaluationStyle === 'strict'
    ? `- Apply the criteria as written. A vague, generic, or one-line answer that does NOT explicitly mention the concrete details a criterion calls for is NOT covered.
- If the answer is missing concrete specifics the criterion asks for (e.g. tools, collaborators, deliverables, cadence), it counts as uncovered — probe for them.
- Do not invent depth that isn't there: "I do meetings and emails" does not satisfy a criterion that asks for specific tools or recurring deliverables.`
    : `- Be lenient BY DEFAULT: if the answer partially or indirectly addresses a criterion, treat it as covered, and don't invent probes the criteria don't ask for.
- Don't reflexively ask someone to break a single named activity into sub-steps.
- The CRITERIA are authoritative. When a criterion defines a specific condition for following up — missing breadth, an unaddressed angle, OR an answer that is only generic activity labels with no real substance (no topic, project, client, deliverable, or tool) — and the answer meets that condition, DO ask the single follow-up that criterion describes. Ask it warmly and specifically, never skeptically.`;
}

// Builds the [system, user] chat messages for coverage judgment + follow-up.
export function evaluateAnswerMessages({
  question,
  answer,
  criteria,
  conversation = '',
  followupCount = 0,
  minFollowups = 0,
  evaluationStyle = 'lenient',
}) {
  const criteriaList = criteria.map((c, i) => `${i + 1}. ${c}`).join('\n');

  // Minimum follow-ups: ask at least this many even when criteria are already
  // met — the extra one digs a little deeper into a task they mentioned.
  const minBlock = minFollowups > followupCount
    ? `\n\nMINIMUM FOLLOW-UPS: you must ask at least ${minFollowups} follow-up(s) for this question and have asked ${followupCount} so far. So EVEN IF every criterion is already satisfied, you still need to ask one more — a natural, curious follow-up that digs a little deeper into the single most interesting or central activity they mentioned — surfacing what they ACTUALLY DO in it (the concrete tasks/steps), phrased freshly per the rules above (not the "what does it involve" mold, and never which specific one or what it's about). When you do this, set "allCovered" to false and provide the followUp.`
    : '';

  // The full interview conversation so far — lets the interviewer ask the next
  // question as a natural continuation rather than a templated probe.
  const convoBlock = conversation && conversation.trim()
    ? `\n\nTHE CONVERSATION SO FAR (the whole interview, most recent last):\n${conversation.trim()}\n`
    : '';

  return [
    {
      role: 'system',
      content: `You are a skilled qualitative interviewer, mid-conversation with a participant about their work. Your job is twofold: judge whether their answer to the CURRENT question satisfies its coverage criteria, and — only when it doesn't — ask the natural next follow-up, as a real interviewer continuing THIS conversation.

Coverage judgment:
${styleRulesFor(evaluationStyle)}

When a criterion is unmet, write ONE follow-up targeting the single most critical unmet criterion. Above all, it must feel like a natural continuation of the conversation you've been having — NOT a standalone probe:
- NEVER LEAD. Do NOT suggest, name, or list any specific task, activity, tool, topic, or example the participant hasn't already said themselves. Proposing a candidate answer plants it — they'll agree or invent to be agreeable, which corrupts the data. Ask OPEN questions that leave the blank for THEM to fill; avoid yes/no questions that float a particular activity.
  ❌ "Beyond the active learning work, did you do any reading or idea development for your research this week?" (invents "reading" and "idea development")
  ❌ "Did you also do things like writing docs or reviewing PRs?" (hands them options to pick from)
  ✅ "Was there anything else that took up your time this week?"
  ✅ When probing an area THEY named: "You mentioned your AI-and-econ research — what did that involve this week?" (asks what they did, without proposing what)
- USE THE WHOLE CONVERSATION. You can see everything said so far. Build on it. Reference earlier things naturally when it helps ("earlier you said you're responsible for hiring — did any of that come up?"). A real interviewer remembers what they've already been told and doesn't ask in a vacuum — but reference only what THEY said, never an activity you've supplied.
- SURFACE MORE TASKS. The whole point of every follow-up is to draw out MORE of the participant's tasks — to come away with concrete tasks you didn't have before. When they name an activity (e.g. "I write papers", "I see patients", "I run trainings"), the most productive move is to ask what they actually have to DO for it — the smaller tasks it breaks into. Do NOT fish for the CONTENT of their work: the topic or subject, what a paper / project / case is "about", or WHICH specific one it was. Knowing the title or topic adds NO new task.
  ❌ "What's one paper you worked on recently?" / "What was the report about?" (content — surfaces no new task)
  ✅ "When you write a paper, what do you need to do to get it done?" or "What does doing research actually look like for you?" (both pull out the constituent tasks — drafting, lit review, revising, making figures…)
- NEVER repeat a question you've already asked, and never re-probe a thread you already covered. If a gap remains only on something you already asked about, move to a different gap or mark it covered.
- VARY how you open — do NOT start follow-ups the same way. "Got it" or "You mentioned…" are fine very occasionally but you're badly overusing them; most of the time just fold their own words into the question and ask directly, the way a person actually mid-chat would.
- Do NOT reuse the same stock SHAPE or filler phrases. You badly overuse the "what does X actually involve / tend to be / look like" mold — e.g. "what does that look like", "what does that involve", "what does the actual work itself tend to be", "what does that usually look like for you" — and the filler "day to day" / "day-to-day". Across the interview these blur into one repetitive question. A phrasing like "what does doing research look like for you?" or "what does that involve?" is FINE occasionally — but do NOT lean on the SAME shape for every follow-up. The filler "day to day" / "day-to-day" may appear AT MOST ONCE in the whole interview: if it already shows up earlier in the conversation, do NOT use it again. Keep VARYING the angle, always aiming at what they DO — what they need to do for it ("what do you need to do to get a paper done?"), the STEPS ("how do you go about that?"), the ACTIONS ("what do you actually do when you do that?"), the PARTS ("what are the different pieces of that work?"), the OUTPUT ("what do you end up producing?"), the PEOPLE ("who do you do that with?"), or the HARD PART ("what's the trickiest bit?"). Do NOT reach for a content example ("which one recently?"). Each follow-up should sound like a genuinely different question, not the same template with a new noun.
- Be RESPONSIVE to the specific thing they just said — pick up that thread, ask what a curious listener would naturally ask next. Different answer → different question, not a template.
- Warm and LOW PRESSURE. Any one concrete thing is a fine answer. NEVER sound skeptical or invalidating; avoid challenge words like "actually". A "no" is valid data.
- One sentence, conversational, no double-barreled questions, no PII.

SKIP DETECTION: if the participant's latest answer is not a genuine attempt to answer but a request to SKIP or move past this question — e.g. "skip", "skip this", "pass", "next", "I'd rather not answer", "no comment", "prefer not to say", "can we move on" — set "skipRequested" to true. A real answer, even a short or negative one ("no", "none", "not really", "nothing comes to mind"), is NOT a skip. When unsure, set it false.

Return JSON: { "allCovered": boolean, "followUp": string | null, "skipRequested": boolean }`,
    },
    {
      role: 'user',
      content: `${convoBlock}\nThe CURRENT question is: "${question}"\nTheir answer to it (so far): "${answer}"\n\nCoverage criteria for the current question:\n${criteriaList}${minBlock}\n\nAre all criteria satisfied? If not (or if the minimum follow-ups above haven't been met), what is the single most natural follow-up to ask next, continuing this conversation?`,
    },
  ];
}

// ── /api/check-coverage ───────────────────────────────────────────────────────

// Builds the [system, user] messages that decide whether an UPCOMING question is
// still WORTH ASKING, given what the participant already said in earlier passes.
// Skip it when asking would just repeat ground they've covered; ask it when it
// could surface something new. Leans toward asking when unsure, so we never
// silently drop a question that could yield a new task. Used to auto-skip a pass
// the participant has effectively already answered.
export function checkCoverageMessages({ question, criteria, conversation = '' }) {
  const criteriaList = criteria.map((c, i) => `${i + 1}. ${c}`).join('\n');
  const convoBlock = conversation && conversation.trim()
    ? `\n\nTHE CONVERSATION SO FAR (the whole interview, most recent last):\n${conversation.trim()}\n`
    : '';

  return [
    {
      role: 'system',
      content: `You decide whether an UPCOMING interview question is still WORTH ASKING, given everything the participant has already said in earlier passes of this same interview. The question is part of a multi-pass interview that surfaces a person's work tasks from different angles, so by the time we reach it they may have already answered it in passing.

Set covered=true (SKIP it) when asking would essentially just repeat ground they've already covered — they've effectively answered it, and it is unlikely to surface any task or detail they haven't already given.
Set covered=false (ASK it) when there's a real chance it surfaces something new.

Lean toward ASKING when genuinely unsure — dropping a question that could surface a new task is worse than asking a slightly redundant one. But DO skip when the answer is clearly already on the table.
- Judge by what they ACTUALLY said, not mere topic overlap: a different question can probe a genuinely different angle even within the same area.
- The criteria below describe what this question is trying to surface — use them to judge whether that's already been covered.
- If the conversation so far is short or thin, ASK.

Return JSON: { "covered": boolean, "reason": string } — reason is one short phrase.`,
    },
    {
      role: 'user',
      content: `${convoBlock}\nThe UPCOMING question is: "${question}"\n\nWhat this question is trying to surface:\n${criteriaList}\n\nGiven everything said so far, is this question still worth asking, or has the participant effectively already answered it in an earlier pass? Return the JSON.`,
    },
  ];
}

// ── /api/interview-question ───────────────────────────────────────────────────

// Builds the [system, user] chat messages to reword a canonical question.
// When `context` (the conversation so far) is provided, the question is TAILORED
// to the participant's role/work so it doesn't read generically.
export function rewordQuestionMessages({ canonicalQuestion, framingNotes = '', context = '' }) {
  const contextBlock = context && context.trim()
    ? `\n\nWHAT THE PARTICIPANT HAS ALREADY TOLD YOU (earlier in this interview):\n${context.trim()}\n\nTAILOR the question to THIS person so it lands specifically, not generically — ground it in their role and the kind of work they've described (e.g. for a nurse, who they work alongside on a shift and who they care for; for a freelance designer, which clients and collaborators). You may reference their role or field. But do NOT invent, name, or list specific people, teams, clients, tasks, or tools they haven't mentioned themselves — only ground it in what they actually said. Still ONE short, natural question.`
    : '';
  return [
    {
      role: 'system',
      content: `You are a friendly interviewer running a short background interview. Reword the upcoming question in your own natural words.

Rules:
- Produce a natural, conversational variant of the canonical question that asks for the SAME information. Preserve its intent and any framing notes EXACTLY.
- It must sound FLUENT and CRISP — like a real person actually speaking. Keep it short and clean. Avoid clunky, padded, or redundant wording (e.g. "the main duties you have in your job", "tasks you handle at your job"). Prefer "What are your main responsibilities at work?" over a longer, more awkward rephrase. If the canonical question is already natural, only lightly vary it — do not pad it.
- One question. Do NOT add new sub-questions, do NOT make it double-barreled, do NOT ask for PII.
- Use plain, universal language that fits ANY job (a nurse, a barista, a teacher, an engineer). Do NOT introduce words that presume seniority or a managerial role — e.g. "oversee", "manage", "lead", "in charge of", "key areas" — unless the canonical question itself used them. Never make the question sound more senior or corporate than the original.

Canonical question: "${canonicalQuestion}"
${framingNotes ? `Framing notes (MUST preserve): ${framingNotes}` : ''}${contextBlock}

Return JSON: { "question": string }`,
    },
    {
      role: 'user',
      content: `Canonical question: "${canonicalQuestion}". Produce the reworded question.`,
    },
  ];
}
