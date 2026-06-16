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
    ? `\n\nMINIMUM FOLLOW-UPS: you must ask at least ${minFollowups} follow-up(s) for this question and have asked ${followupCount} so far. So EVEN IF every criterion is already satisfied, you still need to ask one more — a natural, curious follow-up that digs a little deeper into the single most interesting or central task they mentioned (what it involves, how they go about it, what it's for). When you do this, set "allCovered" to false and provide the followUp.`
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
- NEVER repeat a question you've already asked, and never re-probe a thread you already covered. If a gap remains only on something you already asked about, move to a different gap or mark it covered.
- VARY how you open — do NOT start follow-ups the same way. "Got it" or "You mentioned…" are fine very occasionally but you're badly overusing them; most of the time just fold their own words into the question and ask directly, the way a person actually mid-chat would.
- Do NOT reuse the same stock SHAPE or filler phrases. You badly overuse "what does that look like", "what does that involve", "what does that usually look like for you", and especially "day to day" / "day-to-day" — across several follow-ups they blur into one repetitive question. Do NOT tack "day to day" onto a question as filler. Ask instead about the CONCRETE specific that fits THIS thread: what they actually make or produce, who it's for, the steps they go through, what's hard about it, how often it happens, what tools they use. Each follow-up should sound like a different question, not the same template with a new noun.
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
// already redundant — i.e. earlier answers in this same conversation have already
// satisfied every one of its coverage criteria, so asking it would just repeat
// ground already covered. Deliberately conservative: when in doubt, NOT covered
// (ask the question), so we never silently drop a question that could yield new
// tasks. Used to auto-skip a pass the participant has effectively already answered.
export function checkCoverageMessages({ question, criteria, conversation = '' }) {
  const criteriaList = criteria.map((c, i) => `${i + 1}. ${c}`).join('\n');
  const convoBlock = conversation && conversation.trim()
    ? `\n\nTHE CONVERSATION SO FAR (the whole interview, most recent last):\n${conversation.trim()}\n`
    : '';

  return [
    {
      role: 'system',
      content: `You decide whether an UPCOMING interview question is REDUNDANT — meaning the participant has ALREADY, earlier in this same conversation, said enough to satisfy EVERY one of its coverage criteria, so asking it now would only repeat ground already covered.

Be CONSERVATIVE. Only answer covered=true when ALL criteria are CLEARLY and SUBSTANTIVELY already met by what the participant ACTUALLY said. When in doubt, answer false so the question still gets asked — missing a question is far worse than asking one that turns out slightly redundant.
- Surface overlap in topic is NOT enough; the specific criteria must each be satisfied by concrete things they said.
- Different questions probe different angles. The fact that an earlier question touched the same area does not mean THIS question's criteria are met.
- If the conversation is short or thin, answer false.

Return JSON: { "covered": boolean, "reason": string } — reason is one short phrase.`,
    },
    {
      role: 'user',
      content: `${convoBlock}\nThe UPCOMING question is: "${question}"\n\nIts coverage criteria:\n${criteriaList}\n\nHas the participant ALREADY said enough, earlier in this conversation, to satisfy ALL of these criteria? Return the JSON.`,
    },
  ];
}

// ── /api/interview-question ───────────────────────────────────────────────────

// Builds the [system, user] chat messages to reword a canonical question.
export function rewordQuestionMessages({ canonicalQuestion, framingNotes = '' }) {
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
${framingNotes ? `Framing notes (MUST preserve): ${framingNotes}` : ''}

Return JSON: { "question": string }`,
    },
    {
      role: 'user',
      content: `Canonical question: "${canonicalQuestion}". Produce the reworded question.`,
    },
  ];
}
