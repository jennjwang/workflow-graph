// Shared task-generator prompt used by:
//   - server.js  /api/generate-tasks         (production endpoint)
//   - scripts/test-task-generators.js        (offline strategy comparison)
//
// Single source of truth so the live experience and the offline script stay
// in sync. Tweak this and both places pick it up immediately.

export const UPPER_LEVEL_TASKS_SYSTEM_PROMPT = `You are generating UPPER-LEVEL tasks for someone in this job. These are broad, recurring kinds of work — each one is a category that will later be decomposed into 3–5 concrete sub-steps.

ANCHOR ON O*NET TASK STATEMENTS — that is the granularity target.
- O*NET (the Occupational Information Network) catalogs ~900 occupations with structured task descriptions. An O*NET task is a full action statement — a verb, a concrete object, and (when natural) a short context phrase. Not a one-word verb. Not a multi-paragraph story.
- Length: typically 8–18 words. Sentence case, terminal period.
- USE PLAIN LANGUAGE. Write the way someone would describe the task to a coworker — short, direct words. Avoid formal constructions ("to determine feasibility of", "based on customer complaints and inspection", "in order to ensure", "in accordance with"). Cut any clause that doesn't add meaning.
- Reference shape (cross-occupation, do NOT copy verbatim — they teach the shape, not the content):
  • "Check designs against user needs and cost constraints."
  • "Inspect rental properties before tenant move-out."
  • "Diagnose mechanical problems in customer vehicles."
  • "Document gaps in business processes."
  • "Make coffee drinks for customers during café shifts."
  • "Track equipment performance to plan preventive maintenance."

DO NOT OVERFIT TO THE EXAMPLES BELOW.
  - The examples (research, nursing, retail, trades, etc.) are ILLUSTRATIVE only — they teach the SHAPE of a good task name (verb-led, broad, role-grounded), not the content.
  - NEVER copy an example task name verbatim into your output unless it genuinely belongs in this participant's job. A retail associate's tasks shouldn't include "Read research papers"; an electrician's shouldn't include "Mentor undergrads".
  - Use this participant's own role vocabulary. A barista's tasks should mention "espresso", "drinks", "customers", "shift"; a litigator's should mention "filings", "depositions", "briefs", "clients"; a delivery driver's should mention "routes", "packages", "stops", "vehicle inspections". Match the world this participant lives in.

USE THE TWO PARTICIPANT INPUTS AS DIFFERENT SIGNALS.

You will receive two inputs from the participant — treat them as different kinds of evidence:

  PRIMARY RESPONSIBILITIES = the SCOPE of this person's job. The set of things they are accountable for. This bounds what tasks may appear in your output. EVERY upper-level task must trace back to one of these responsibilities. If a candidate task cannot be mapped to any stated responsibility, DO NOT include it — even if it is typical for the role.

  TYPICAL WEEK = the activity-level evidence of what they actually do within that scope. Use it to choose the right granularity, the right vocabulary, and to confirm WHICH responsibilities are active in their current week.

  When the two signals conflict, prefer PRIMARY RESPONSIBILITIES — that defines the job; the week is one sample.

  Rules for using these signals:
  - If a responsibility is listed but no week activity appears under it, still include a task for it — the responsibility is the canonical scope statement.
  - If a week activity does not fit any stated responsibility, you may include it (responsibilities lists are often incomplete) — but treat it as lower-confidence.
  - If the typical-week answer makes clear they DON'T do something (e.g. "no experiments", "no in-person meetings"), DO NOT include that task even if it is role-typical.
  - DO NOT invent categories the participant did not mention in either input. The participant should never be the one to discover an invented task.
  - If only PRIMARY RESPONSIBILITIES is provided (TYPICAL WEEK missing): generate tasks strictly from responsibilities; do not improvise activities.
  - If only TYPICAL WEEK is provided (PRIMARY RESPONSIBILITIES missing): use week-only ground truth as before; do not extrapolate beyond it.

THE RESULT MUST BE MECE — Mutually Exclusive, Collectively Exhaustive.

  MUTUALLY EXCLUSIVE: any specific concrete activity in this person's week should fit under EXACTLY ONE task. No two tasks should overlap in scope. Three common overlap patterns to watch for:
    - ✗ Same activity, different AUDIENCE — "Coordinate with engineering" + "Coordinate with design". Merge into one cross-team coordination task.
    - ✗ Same activity, different INPUT — "Run vision screenings" + "Run hearing screenings". Merge into "Run student health screenings".
    - Same activity, different STAGE — sequential phases of one workflow ("Plan experiments" / "Run experiments" / "Analyze results"; "Develop proofs" / "Write proofs in LaTeX"). DEFAULT: keep them separate as long as each stage is its own multi-step activity (different tools, outputs, or cognitive mode) — the participant can decide on the next step whether to collapse. ONLY merge if the stages blur together continuously in practice (e.g. "Read draft" + "Revise draft" happen interleaved).
    - THE TEST: take a concrete activity (e.g. "reply to an email from a parent"). Does it fit under more than one of your tasks? If yes, the tasks overlap — restructure.

  MERGE BY ACTIVITY, NEVER BY CONTEXT. The three patterns above merge ONE activity that varies by audience/input/stage. The opposite move is a mistake: do NOT bundle DIFFERENT activities into one task just because they share a CONTEXT — the same WHO ("to help others", "for the team"), the same WHEN ("when busy", "during downtime", "after close", "on call"), or the same WHERE. Context is not an activity and must never define a task or justify a merge.
    - ✗ "Help other cooks with prep, plating, and dishwashing when busy" — three distinct activities (prep / plating / dishwashing) glued by "helping others". Each is its OWN task; "helping others when busy" is just context — drop it.
    - ✗ "Cover the front desk during breaks" — name the actual activities (answer phones, greet visitors, take payments), not the coverage window.
    - ✗ "Handle whatever the team needs during the rush" — a context catch-all, not a task.
    A distinct activity stays its own task even if it only happens to help someone else, only at a certain time, or only in a certain place. If you catch yourself naming a task by who/when/where instead of by the action, decompose it into the real activities and map each to its own task.

  COLLECTIVELY EXHAUSTIVE: together the tasks must cover EVERYTHING someone in this role does in a typical week. Imagine the participant's full week minute-by-minute — every activity should map to one of the tasks.
    - Don't forget: admin paperwork, learning/training, communication with external parties, periodic reporting, equipment/space/inventory upkeep, mandated compliance.
    - THE TEST: name an activity from this role's typical week. Does it fit under one of your tasks? If you can name something that fits NONE of them, you're missing a category — add it.

CORRECT GRANULARITY = O*NET TASK STATEMENT.
- Match the O*NET shape: a full action statement (verb + concrete object + short context phrase), 8–18 words, sentence case, terminal period. NOT a bucket label ("Run morning cafe setup") and NOT a one-word verb. Every task should read like plain speech, not a job description template.
- Each task should still plausibly contain 3–5 distinct sub-activities underneath it — but the task name itself is the full statement, not the category header.

  COHERENT-ACTIVITY TEST: each task must be a coherent recurring activity, not a one-off action and not a literal sub-step of another listed task. Each becomes a workflow tree the participant expands next, so it has to have real substructure.
  - ✗ "Dial in espresso"                                                            — sub-step of espresso prep.
  - ✗ "Drive to job sites"                                                          — transit, not the work itself.
  - ✗ "Tighten lug nuts"                                                            — sub-step of tire service.
  - ✗ "Run morning cafe setup"                                                      — bucket label, not an action statement; rewrite as a plain statement below.
  - ✓ "Open the cafe for the morning shift."
  - ✓ "Follow up on permit applications with the city."
  - ✓ "Take and ring up customer orders at the counter."
  - ✓ "Diagnose residential wiring issues during service calls."

  TOO NARROW (a sub-step) — DON'T:
  - ✗ "Reply to a single Slack message"     (one micro-action)
  - ✗ "Restock the milk fridge"             (sub-step of opening the cafe)
  - ✗ "Verify a medication dose"            (sub-step of medication management)
  - ✗ "Tighten lug nuts after a tire swap"  (sub-step of tire service)

  TOO VAGUE — THE OBSERVABLE-ACTION TEST.
  Imagine watching a 30-second video of the participant doing this task. Could you describe what they are physically doing? If you can only say "they're managing it" / "they're advancing it" / "they're handling it" — the task name is vague, even if the noun is concrete.

  The test applies to the WHOLE PHRASE, not just the verb. A vague verb paired with a concrete noun is STILL VAGUE — pairing "manage" with "electrical permits" does not save the task.

  - ✗ "Manage electrical permits"      → use the action: "Pull electrical permits", "File and follow up on permits".
  - ✗ "Advance dissertation research"  → they're writing, proving, reading. The dissertation is the goal, not a task.
  - ✗ "Drive product strategy"         → what action? "Write quarterly roadmaps", "Decide feature priorities".
  - ✗ "Oversee inventory"              → "Count inventory", "Order restocks".
  - ✗ "Provide day-to-day care"        → "care" is the abstract aggregate; name the actual care activities (treating injuries, giving meds).
  - ✗ "Handle daily duties"            → "duties" is abstract; the whole job is one.
  - ✗ "Engage with the community"      → which engagement? Events? Meetings? Outreach?
  - ✗ "Do shift work"                  → the entire job is the shift.
  - ✗ "Handle logistics"               → logistics of WHAT, doing WHAT to it?
  - ✗ "Take care of operations"        → operations of WHAT, doing WHAT?

  COMMON OFFENDER VERBS — status / outcome / aggregate verbs that fail the test even with concrete nouns: manage, oversee, supervise (unless literally managing people), handle, deal with, take care of, engage, participate, advance, drive, progress, own, ensure, facilitate, enable, support, do, perform, address, work on.

  These verbs describe what the work produces, or the relationship to the work, NOT the work itself. Replace each with the action verb the participant would actually use to a coworker: "file", "call", "write", "review", "count", "decide", "draft", "send", "install", "diagnose", "teach", "ask", "read", "inspect", "treat", "administer".

  ADMIN tasks specifically: don't write "Handle administration" / "Manage paperwork". Name the specific admin work for the participant's role — examples across different roles:
  - ✓ "Submit timesheets"               (most hourly roles)
  - ✓ "File insurance claims"           (clinic)
  - ✓ "Track inventory levels"          (retail / restaurant)
  - ✓ "Update compliance logs"          (regulated trade)
  - ✓ "Process expense reports"         (manager)
  - ✓ "Submit court filings"            (law)

  JUST RIGHT — examples of well-shaped, plain-language tasks across many roles (do NOT copy these into every output; they show the SHAPE):
  - ✓ "Take medical histories from new patients." (decomposes: greet, review chart, ask questions, document)
  - ✓ "Teach lessons across multiple subjects each day." (decomposes: open the day, deliver lesson, manage transitions, close out)
  - ✓ "Cut and style hair for salon clients." (decomposes: consult, wash, cut, style, settle payment)
  - ✓ "Inspect rental properties before tenant move-out." (decomposes: schedule, walk-through, photo, write report)
  - ✓ "Service brake systems on customer vehicles." (decomposes: lift, inspect, replace parts, road test)
  - ✓ "Brew espresso drinks for customers during café shifts." (decomposes: pull shots, steam milk, build drink, hand off)
  - ✓ "Draft and redline contract amendments for clients." (decomposes: review terms, negotiate, redline, finalize)
  - ✓ "Run package delivery routes by van." (decomposes: load van, navigate, scan packages, get signatures)

  THE VAGUENESS TEST: take your task name. Could it apply unchanged to a completely UNRELATED job (a teacher → a chef → an accountant)? If yes, it's too vague — replace the abstract noun with the role's specific artifact, audience, or output. (Task names that apply across closely related roles — e.g. nurse / NP / doctor all "take patient histories" — are fine; the test is for jobs with no domain overlap.)

GROUND IN THE ROLE. Use the role's actual vocabulary — its tools, artifacts, audiences, locations, outputs. Not generic office language.

PLAIN LANGUAGE. Verb-led action statement, sentence case, 8–18 words, terminal period. Use everyday words — the language someone would actually say to a coworker. Avoid corporate-speak ("stakeholders", "leverage", "drive alignment", "cross-functional", "ideate", "synergize") and formal legal/academic constructions ("to determine feasibility of", "in order to ensure", "based on X and Y", "in accordance with").

NAME MUST BE SELF-EXPLANATORY. The task statement has to stand on its own — a participant will read it once with no context other than their job, and immediately know what the task means. If the statement needs an explanation to be understood, it's not specific enough — make it more concrete by naming the actual artifact, audience, output, or context.
- ✓ "Inspect rental properties before tenant move-out to document condition and damage."   (specific use case)
- ✗ "Run inspections."                          (inspections of what, with what purpose?)
- ✓ "Triage walk-in patient complaints to determine urgency and route to appropriate care." (specific input + purpose)
- ✗ "Triage cases."                             (cases of what?)
- ✓ "Replace residential breaker panels during scheduled service calls."                   (specific artifact + context)
- ✗ "Replace panels."                           (panels of what?)
- ✓ "Greet and seat dinner guests during the evening service."                             (specific audience + setting)
- ✗ "Handle guests."                            (handle how?)
- ✓ "Draft software design documents to specify new feature requirements for engineering review." (specific output + audience)
- ✗ "Write docs."                               (which docs?)

RIGHT GRANULARITY — ONE ACTIVITY PER TASK. The "too broad" complaint is about GRANULARITY, not word choice: a single statement that bundles several DISTINCT activities reads as too coarse. A task that strings together different actions is really multiple tasks:
- ✗ "Draft, revise, and publish research papers."          → drafting, revising, and submitting are THREE separate activities → three tasks.
- ✗ "Write code and build research systems for experiments." → writing analysis code and building/maintaining systems are different work → split.
- ✗ "Present findings and explain statistical concepts."     → presenting results and explaining concepts are two activities → split.
- ✗ "Develop research questions and decide experiment setups." → two activities → split.
Each distinct action the person does as its OWN piece of work gets its OWN task — that is the granularity participants expect. SPLIT a bundled statement; do NOT just reword it. KEEP combined ONLY when it is genuinely ONE continuous action, or a "such as" list of KINDS/CASES of the SAME action ("Clean and reshape raw data, such as removing duplicates and filling gaps"). TEST: if the verbs name things done at different times or as separate pieces of work, they are separate tasks. (This does NOT mean drop to sub-step level — "revise papers" is still a whole activity with its own sub-steps; it means don't fuse several whole activities into one line.)

NEUTRAL PHRASING. Never use "our", "my", or "the team's" — write neutral articles ("the schedule", "a customer order", "students") instead.

ONE THING PER TASK — PREFER SPLITTING. If you find yourself writing "X and Y" as a task name, that is a signal to OUTPUT TWO TASKS, not one merged task. Examples:
  - ✗ "Meet with advisor and lab"           → ✓ "Meet with advisor" + ✓ "Present at lab meeting"
  - ✗ "Write dissertation and paper drafts" → ✓ "Draft dissertation chapters" + ✓ "Draft conference papers"
  - ✗ "Run bar setup and closeout"          → ✓ "Run morning cafe setup" + ✓ "Run end-of-day closeout"
  - ✗ "Treat illnesses and injuries"        → ✓ "Triage student illnesses" + ✓ "Treat student injuries"
Only use a single noun phrase (no "and") when a clear umbrella term genuinely covers both things at the same observable-action level ("Run health screenings" covers vision and hearing because both are the same activity with different inputs). When the two items differ in audience, format, cadence, or output — split them.

  SAME-OUTPUT TEST (the sharp rule for "X and Y"). Merge two verbs into ONE task only when they are the SAME FUNCTION serving the SAME GOAL and producing ONE shared output — sequential micro-steps of a single deliverable. If each half has its OWN deliverable, SPLIT, even when they share a goal:
  - ✓ "Calculate and record accruals for expenses and revenues." — calculate → record is one bookkeeping action with one output (the booked accruals).
  - ✓ "Review and approve teammates' code changes." — one gatekeeping decision, one output.
  - ✓ "Collect, preprocess, and curate datasets for model training." — one data-prep pipeline toward one output (a training-ready dataset).
  - ✗ "Document methods and write research papers." — same goal (share the work) but TWO outputs: internal documentation vs. a paper → split.
  - ✗ "Review code and prepare trained models." — different function AND different output → split.
  - ✗ "Prepare audit schedules and support financial reviews." — a schedule vs. review support are two deliverables → split.

  THE "SUCH AS" / "INCLUDING" DISCIPLINE (from O*NET cluster synthesis). When you fold variety into one task, do it cleanly:
  - Every item you fold in must read as a KIND or CASE of the task statement. "Wash" and "chop" are cases of prepping vegetables (fine to combine); "restock inventory" is NOT a case of "clean counters", and "plate dishes" is NOT a case of "cleaning" — those are different activities, so SPLIT them.
  - Use a "such as"/"including" list ONLY for genuinely DIFFERENT KINDS of the SAME activity, AT MOST 3, named generically, in the OBJECT only — NEVER to glue different ACTIONS. Prefer a plain generic object over a list when one word covers the kinds ("unit and integration tests" → "automated tests").
  - If the items all name the same activity, just restate it cleanly with a generic object — no list at all.
  - Stay as SPECIFIC as the shared activity allows; never widen to a vague umbrella just to make items fit. If no statement covers them without going vague, they are different activities — split.
  The participant filters further on the next step.

COUNT. Aim for 25–30 tasks. MECE and the COHERENT-ACTIVITY test outrank the count — NEVER pad with one-off micro-actions or sub-steps to hit a number. But also DON'T under-generate: if you're tempted to merge two activities via " and " (different audiences, formats, cadences, or outputs), output them as TWO tasks instead — see "ONE THING PER TASK" above. The participant filters further on the next step, so a slightly longer list is better than a list that pre-merged distinct activities.

Before finalizing, mentally walk through the participant's week and confirm:
  (a) every task you propose maps back to a stated PRIMARY RESPONSIBILITY (or, if responsibilities are absent, a typical-week activity) — nothing invented,
  (b) every activity they mentioned in their TYPICAL WEEK fits under exactly one task,
  (c) no two tasks overlap (re-check the audience and input overlap patterns; for sequential-stage tasks, confirm each stage is its own multi-step activity rather than a continuous workflow with the previous one),
  (d) you haven't merged separable activities just to shorten the list,
  (e) the vocabulary belongs to THIS role — not to research, software, or any role you saw in the examples.

Return ONLY valid JSON: {"tasks": [{"name": "..."}]}`;

// Build the upper-level tasks prompt. Default is the full role-based prompt
// (collectively exhaustive over the occupation, ~25–30 tasks). In ANCHORED mode
// — used when generating from a specific participant's interview — the two
// occupation-wide rules are relaxed so the base prompt doesn't contradict the
// participant-anchored instructions:
//   • "Collectively Exhaustive over the role" → "Mutually Exclusive + only the
//     important gaps implied by THIS person's own responsibilities/week".
//   • the fixed "Aim for 25–30" count → a dynamic ceiling (the picker's cap).
export function buildUpperLevelTasksPrompt({ anchored = false, count } = {}) {
  if (!anchored) return UPPER_LEVEL_TASKS_SYSTEM_PROMPT;
  const ceil = Number.isFinite(+count) && +count > 0 ? Math.round(+count) : null;
  return UPPER_LEVEL_TASKS_SYSTEM_PROMPT
    .replace(
      'THE RESULT MUST BE MECE — Mutually Exclusive, Collectively Exhaustive.',
      'THE RESULT MUST BE MUTUALLY EXCLUSIVE — no two tasks overlap. It need NOT be collectively exhaustive over the whole occupation: you are anchored to THIS specific participant, not to the role in general.',
    )
    .replace(
      `  COLLECTIVELY EXHAUSTIVE: together the tasks must cover EVERYTHING someone in this role does in a typical week. Imagine the participant's full week minute-by-minute — every activity should map to one of the tasks.
    - Don't forget: admin paperwork, learning/training, communication with external parties, periodic reporting, equipment/space/inventory upkeep, mandated compliance.
    - THE TEST: name an activity from this role's typical week. Does it fit under one of your tasks? If you can name something that fits NONE of them, you're missing a category — add it.`,
      `  ANCHORED COVERAGE (NOT occupation-wide exhaustiveness): cover what THIS participant actually described, plus only the IMPORTANT gaps clearly implied by their own responsibilities and week. Do NOT add tasks to "complete" the occupation — peripheral, occasional, or generic role-filler they never mentioned is noise here, and its specificity won't match the rest. A short, faithful list beats a padded one.`,
    )
    .replace(
      `COUNT. Aim for 25–30 tasks. MECE and the COHERENT-ACTIVITY test outrank the count — NEVER pad with one-off micro-actions or sub-steps to hit a number. But also DON'T under-generate: if you're tempted to merge two activities via " and " (different audiences, formats, cadences, or outputs), output them as TWO tasks instead — see "ONE THING PER TASK" above. The participant filters further on the next step, so a slightly longer list is better than a list that pre-merged distinct activities.`,
      `COUNT. The exact size and composition are set in the run-specific instructions below.${ceil ? ` In all cases the total must not exceed ${ceil}.` : ''} Mutual-exclusivity and the COHERENT-ACTIVITY test outrank the count.`,
    );
}

// ── Interview-task extraction (/api/extract-interview-tasks) ──────────────────
// Pulls the recurring paid-work tasks the participant explicitly mentioned,
// faithfully at the granularity they were said. The generator below rolls these
// up into MECE upper-level tasks.
export const INTERVIEW_TASK_EXTRACTOR_PROMPT = `Extract the distinct recurring work tasks this person performs in their paid job.

Rules:
- Paid work only: skip anything the background explicitly labels as personal, hobby, or side project.
- Faithful to the text: extract tasks at the granularity they appear. Don't collapse or invent
  hierarchy — if the background lists sub-items under an activity, emit them as separate tasks
  rather than rolling them up into one broad parent.
- ONE THING PER TASK — SPLIT BUNDLED OBJECTS. When a single stated activity bundles multiple
  distinct objects, outputs, or audiences via "and" or commas, emit ONE task per item rather than
  one merged task. The bundling is usually just how it was said in one breath, not evidence the
  items are one activity. KEEP THE STATED VERB on every split-out task — don't invent a new
  activity for one item (if they said "advise on references", it is "Advise students on references",
  NOT "Write student reference letters").
  "advise students on research projects, references, and job applications"
    → "Advise students on research projects" + "Advise students on references" + "Advise students on job applications"
  "teach lectures and grade exams" → "Teach course lectures" + "Grade student exams"
  BUT DON'T OVER-SPLIT THE SAME ACTIVITY. If the items are the SAME verb performed with the same
  tools/procedure and only the input or sub-type differs, they are ONE task — merge them under a
  generic object, do NOT emit one task per input. The split rule above is for distinct ACTIVITIES
  that happened to be said together, not for sub-types of a single activity.
  "run vision and hearing screenings" → "Run student health screenings" (ONE task, not two)
  "fix bugs in the frontend and backend" → "Fix software bugs" (ONE task, not two)
  "review unit, integration, and end-to-end tests" → "Review automated tests" (ONE task, not three)
  Named technical sub-types of one output — test layers (unit/integration/e2e), environments
  (staging/prod), document versions — are the SAME activity: merge under a generic object.
  Litmus test: would the split-out items read like the SAME line repeated with one word swapped?
  Then keep them merged.
  CONTRAST — these DO split, because each names a genuinely different output FORMAT or AUDIENCE,
  not a sub-type of one output: "write blog posts and API documentation" → TWO tasks (a blog post
  and API docs are different artifacts for different readers); "advise students and parents" → TWO
  (different audiences). Only split when the items differ in output format, audience, or cadence —
  NOT when they're interchangeable inputs/sub-types of a single output.
- RESCUE, DON'T DROP: aim to turn EVERY work-related mention into a task — do not silently discard
  one for being awkwardly phrased or low-quality. If something is stated as a goal/outcome ("reduce
  coding time"), a role/headcount description ("lead a team of 8"), or a vague label ("handle
  operations", "deal with clients"), reformulate it into the concrete recurring activity behind it,
  using the surrounding context to infer what they actually DO (e.g. "lead a team of 8" → "Assign
  and review the team's work"; "deal with clients" → "Respond to client requests and questions").
  When you reformulate, do your best to write a CLEAR task statement that fits THIS profession and
  represents the participant's intention — use the job/role context and their other answers to
  express what the vague phrasing was reaching for, in the words a practitioner would use.
  Dropping IS allowed, but only as a last resort: if a mention is genuinely meaningless — no
  recoverable work activity at all, e.g. bare schedule/logistics ("work from home", "start at 9 AM")
  or content-free filler ("work hard", "be more productive") — leave it out rather than inventing a
  task from nothing. Rescue whenever a real activity is recoverable; drop only when it truly isn't.
- For AI usage: extract the specific named activity, not the AI scaffolding, and mark it by
  appending " using AI" so downstream can tell AI-performed tasks apart.
  "use AI to write proposals" → "Write job proposals using AI"
  "use AI to debug failing tests" → "Debug failing tests using AI"
  If the activity already names AI as part of the object, leave it and don't double-mark:
  "reviewing AI-generated code" → "Review AI-generated code"
  Only include if it's a distinct bounded activity mentioned in the text; skip generic
  statements like "use AI to work faster" or "automate tasks with AI".
- Form: Action → Object → to <Purpose/Result>. Present-plural verb, no first person, no invented
  detail; add the purpose/result clause only when it distinguishes the task.

Return ONLY a JSON object: {"tasks": ["task 1", "task 2", ...]}.`;

// ── Participant-anchored generation (/api/generate-tasks-from-interview) ───────

// The mentioned-tasks block injected into the generator's user message.
export function mentionedTasksBlock(interviewTasks = []) {
  return interviewTasks.length > 0
    ? `\nTASKS THE PARTICIPANT EXPLICITLY MENTIONED (every one must be COVERED by exactly one task in your output — absorbed/merged as needed, never copied in verbatim or dropped):\n${interviewTasks.map((t) => `- ${t}`).join('\n')}\n`
    : '';
}

// Normalize the participant's mentioned tasks into a MECE upper-level list —
// their OWN tasks only, no invented role coverage. `count` is the burnout cap.
export function buildAnchoredTaskSystemPrompt(count) {
  return `${buildUpperLevelTasksPrompt({ anchored: true, count })}

SPECIAL INSTRUCTIONS FOR THIS RUN — PARTICIPANT-ANCHORED MODE:
You are given the activities this participant explicitly named when describing their own job. They were extracted FAITHFULLY at whatever granularity they happened to be said — so the list is usually a mix of broad activities and fine sub-steps, and some items overlap each other. Your job is to produce ONE clean MECE upper-level list that COVERS all of them.

MECE IS THE MASTER CONSTRAINT. The mentioned tasks are evidence to be covered, NOT items to copy in verbatim:
1. RESCUE BEFORE YOU DROP. Strongly prefer representing every mentioned item — don't discard one just because it's low-quality or vaguely phrased. If an item is too vague ("do meetings", "handle stuff"), a goal/outcome ("be more productive"), or a role descriptor ("lead a team"), reformulate it into the most concrete task that captures the underlying work, inferring from their OTHER mentions what they actually DO (e.g. "lead a team" → "Coordinate and review the team's work"; "do meetings" → fold into the specific meetings they describe, or "Run recurring team meetings"). When you reformulate, do your best to write a CLEAR, well-formed task statement that fits THIS profession and represents the participant's intention — use the job/role context and their other answers to express what the vague phrasing was reaching for, in the words a practitioner of this occupation would use. Dropping IS allowed, but only as a last resort: if a mention is genuinely meaningless — no recoverable work activity at all (pure scheduling like "start at 9am", or content-free filler like "work hard") — drop it rather than inventing a task from nothing. Rescue whenever a real activity is recoverable; drop only when it truly isn't.
2. COVER, don't paste. Every mentioned task must map to EXACTLY ONE task in your output. That does NOT mean it appears verbatim: roll fine sub-steps UP into the broader O*NET-level category that contains them, and MERGE mentioned tasks that are the same activity. (E.g. "Review code" + "Approve PRs" → one "Review and approve teammates' code changes"; "Run vision screenings" + "Run hearing screenings" → "Run student health screenings".) Nothing they said is lost — but it may be ABSORBED into a broader task rather than standing alone. KIND/CASE TEST: each mentioned task you absorb must read as a KIND or CASE of the output task. If it doesn't — "plate dishes" is not a case of "clean the station" — it's a different activity; give it its own task. A DIFFERENT ACTION on the same object is its OWN task, NOT a kind of the other: writing code, debugging code, and reviewing code are three distinct activities even though all involve "code"; drafting a paper and submitting it are two. Only absorb when the items are genuinely the SAME action. Stay as specific as the shared activity allows; don't widen to a vague umbrella to swallow it. Lean toward keeping distinct work SEPARATE — merge only when items are clearly one and the same activity.
3. NO OVERLAP AMONG THE MENTIONED TASKS EITHER. Apply the overlap patterns to THEM: same activity / different AUDIENCE, same activity / different INPUT. Treat "different STAGE" NARROWLY — only merge micro-stages of ONE continuous action (e.g. drafting then proofreading the same document). Do NOT merge distinct steps of a lifecycle that are each their own action: writing a paper, submitting it to a venue, and presenting it are THREE separate tasks, not one; designing an experiment, running it, and analyzing the results are separate. If two mentioned tasks fail the test ("could the same minute of their day be described by both?"), they belong to ONE output task. Run the REVERSE check too: never roll DIFFERENT activities into one task because they share a context (who it's for, when, where) — "help others with prep, plating, and dishwashing" is THREE tasks, not one; map each mentioned item to the task for its actual activity (their plating → a plating task), not to a "helping" or "when busy" bucket. WHEN GENUINELY UNSURE whether two items are one activity or two, keep them SEPARATE — the participant merges/filters further on the next step, so a slightly finer list beats one that fused distinct work.
4. NORMALIZE to O*NET standard: verb-led, 8–18 words, plain language, specific. Preserve their vocabulary — keep their nouns, tools, and context.
5. Cover ONLY what they actually described (rolled up). Do NOT add tasks they didn't mention — that's handled separately. NEVER manufacture overlapping or near-duplicate tasks.
6. SELF-CHECK: (a) every recoverable mentioned task is represented — a vague or awkward one was REFORMULATED into a concrete task rather than dropped, and only genuinely meaningless mentions were left out; (b) each maps to exactly one output task; (c) no two output tasks overlap; (d) granularity is consistent O*NET level throughout.
7. ${count} is a CEILING, never a target to compress toward. MECE and the one-activity-per-task rule OUTRANK it: NEVER merge two different activities into one "X and Y" line to stay under the ceiling. If genuinely distinct activities would exceed ${count}, keep the most central and DROP the rest — never fuse distinct work into a single task to fit the number.`;
}

// ── Gap-fill: INFERRED tasks the participant did NOT explicitly say ────────────
//
// Runs AFTER the anchored list is built. Adds a small number of recognition
// tasks the participant likely does but never stated — inferred from THIS
// SPECIFIC PERSON: both their described work AND their stated background
// (seniority, domains, portfolio), pitched at their level. Not occupation-wide
// title-padding. MECE with the already-built list, as specific as the rest.
// Emitted at LOW confidence, tagged source:'gap'.
export function buildGapFillSystemPrompt(count, alreadyTasks = []) {
  const haveBlock = alreadyTasks.length
    ? `\n\nTASKS ALREADY IN THEIR LIST — do NOT repeat, restate, or add a KIND/CASE of any of these:\n${alreadyTasks.map((t) => `- ${t}`).join('\n')}`
    : '';
  return `You are adding a FEW inferred "you might also do this" tasks to a participant's task list. They have already described their job; the list of tasks they explicitly named is below. Your job: propose up to ${count} ADDITIONAL recurring tasks they very likely do but did NOT mention — and return ONLY the MOST IMPORTANT, mutually exclusive ones.

THE HARD RULE — INFER FROM THIS SPECIFIC PERSON, NOT FROM A GENERIC JOB TITLE. Anchor every task you add in something THIS participant actually told you — and use BOTH:
  (a) their described WORK — the responsibilities, weekly tasks, and activities they named; and
  (b) their stated BACKGROUND — their seniority and level, the years and roles of experience they mention, the specific industries / domains / clients / institutions they name, and the full portfolio of practices they say they operate (e.g. someone who advises boards, spans consulting + teaching + coaching, or has 25 years in senior leadership).
Use that background RICHLY: surface the tasks that a person with THAT background, operating at THAT level, doing THIS described work, very likely also does. A good addition is a likely NEIGHBOR, NEXT-STEP, or LEVEL-APPROPRIATE counterpart of what they described or who they are — e.g. a senior leader who names board members and investors among their stakeholders very likely does board-level / governance advisory, even if they didn't list it as a task.
PITCH AT THEIR LEVEL. Match the seniority and framing of their actual work: for a senior, strategic, or advisory professional the inferred tasks should be senior and strategic (shaping strategy, advising leadership/boards, governance), NOT junior execution.
What to DROP: generic filler whose ONLY justification is "people with this title usually do this", with no anchor in who THIS person is or what they described. The test is specificity to THEM (their work AND their background), not avoidance of inference.
- ✓ Runs experiments and writes papers → "Respond to peer-review feedback and revise papers for resubmission." (next-step of submitting papers)
- ✓ Background: 25 years senior leadership, names board members/investors among stakeholders → "Provide board-level and governance advisory on strategic decisions to senior leadership." (implied by their seniority + stated board interactions)
- ✗ Generic filler with no anchor in their work OR background: "Keep records up to date", "Attend company meetings", "Respond to email" — DROP unless they specifically pointed at it.

CONSTRAINTS:
- MUTUALLY EXCLUSIVE — each addition must be a genuinely DISTINCT activity: not a duplicate, restatement, kind/case, or subset of (a) any task already in their list, OR (b) any other task you add here. Tasks serving the SAME underlying activity or objective count as overlapping even when the channel, medium, or occasion differs (e.g. emailing parents vs. meeting parents is ONE task; routine coaching vs. competition-day prep is ONE task). When candidates overlap, keep only the single most important and drop the rest.${haveBlock}
- SPECIFIC and same shape as the rest: O*NET style, verb-led, 8–18 words, sentence case, terminal period, plain language. Name the actual artifact / audience / output — match the specificity of their other tasks, do NOT go vague.
- MOST IMPORTANT ONLY — QUALITY OVER QUANTITY. ${count} is a CEILING, not a target. Rank candidates by how central they are to THIS person's role and return only the most important, well-anchored, mutually exclusive ones; if only two qualify, return two. Zero is fine.

OUTPUT: one JSON object per line (JSONL), no array, no commentary:
{"name": "...", "confidence": 0.0-1.0}
These are INFERRED, so confidence is LOW by definition — use 0.1–0.3, higher only when the implication is very strong.`;
}

// ── Gap-probe: turn coverage gaps into OPEN interview questions ────────────────
//
// Live, mid-interview. Reads the raw transcript directly (no separate extraction
// pass — the only extraction happens later, at generation, on the full transcript
// INCLUDING these answers). Finds the COVERAGE GAPS — substantive, role-distinctive
// tasks they almost certainly do but didn't bring up — clusters them into a few
// areas, and drafts ONE open, NON-LEADING follow-up question per area (the hidden
// task is never named). Anchors must be verbatim quotes from the transcript or null.
export function buildGapProbeMessages({ jobTitle, responsibilities, typicalWeek, transcript = '', maxAreas = 3 }) {
  return [
    {
      role: 'system',
      content: `You are improving a work-task interview. Below is the interview transcript so far. Find the COVERAGE GAPS — recurring tasks someone in THIS specific role almost certainly does but did NOT bring up anywhere in the transcript — and group them into a few AREAS we can probe with ONE open follow-up question each.

Return ONLY JSON:
{
  "areas": [
    {
      "area": "<short label for this slice of the job>",
      "hiddenGapTasks": ["<specific recurring task absent from the transcript>", "..."],
      "anchor": "<a VERBATIM quote (exact words) from the participant's answers in the transcript that this area connects to, or null>",
      "question": "<one OPEN, NON-LEADING question inviting them to describe work in this area WITHOUT naming any hidden gap task>"
    }
  ]
}

GAPS — SUBSTANTIVE AND ROLE-DISTINCTIVE ONLY (NO FILLER):
- Each gap must be a CONCRETE, recurring task specific to THIS role — name the actual artifact, system, document, or action a person in this exact job does. Grounded in their job title, responsibilities, and week.
- BAN GENERIC FILLER. Reject any candidate that would apply to almost any office/professional job, e.g. "stay updated with industry trends", "attend training", "keep skills up to date", "prepare administrative reports", "maintain records", "communicate with internal teams", "coordinate with colleagues", "manage your time", "respond to emails". If a whole area reduces to filler, DROP the area.
- A gap is NOT already covered by something they described in the transcript (compare meaning, not wording). If it's a kind/case of something they already said, it is NOT a gap.
- NEVER import tasks from another job; never invent something implausible.
- Return AT MOST ${maxAreas} areas, most central/likely FIRST. QUALITY OVER QUANTITY — if the interview already covers the role well, return FEWER (even zero) rather than padding. A short list of real, specific gaps beats a long list with filler.

ANCHORS — VERBATIM ONLY:
- "anchor" must be an EXACT substring of the participant's answers in the transcript (copy their words letter-for-letter). Do NOT paraphrase, summarize, or invent. If you cannot quote them exactly for this area, set "anchor" to null.
- When anchor is null, the question must NOT begin with "You mentioned" or claim they said anything.

QUESTIONS — CRITICAL, MUST NOT LEAD:
- NEVER name or hint at a hidden gap task. If a hidden task is "reconcile intercompany balances", do NOT say "reconcile", "intercompany", or "balances" — ask about the AREA openly.
- NO META / PEER-COMPARISON. NEVER ask them to compare themselves to others or name their own gaps ("how do your tasks differ from others in your profession?", "anything you do that they don't?", "what's unique about your work?"). That offloads the gap-analysis onto them. You name the specific area; ask about THAT.
- Anchor to the participant's OWN verbatim words when anchor is non-null ("You mentioned <their exact phrase> — ...").
- Phrase as an open invitation answerable with NEW tasks in their words, or with "no": "is there anything else you regularly do around ___?", "what does ___ usually involve for you?".
- One sentence, plain and conversational. One question per area. "No" must be a fine answer.`,
    },
    {
      role: 'user',
      content: `Job title: ${jobTitle}
Responsibilities: ${responsibilities || '(none given)'}
Typical week: ${typicalWeek || '(none given)'}

FULL INTERVIEW TRANSCRIPT (find what's MISSING from this; anchors must be exact quotes from the A: lines):
${transcript || '(none)'}

Identify the coverage gaps, grouped into areas, each with one open non-leading question.`,
    },
  ];
}

// ── Occupation matcher (retrieval grounding) ──────────────────────────────────
//
// Used by lib/retrieval.js to pick the corpus occupation(s) whose task
// statements best ground this participant's generator run. The model is given
// the full occupation list and must choose ONLY from it.
//
export const OCCUPATION_MATCH_SYSTEM_PROMPT = `You match a participant to the closest occupation(s) from a fixed list.

You are given a numbered list of occupations and a short description of one participant (job title, responsibilities, typical week). Choose the occupation(s) from the list whose day-to-day work most overlaps with this participant's actual work.

RULES:
- Choose ONLY from the provided list. Copy the occupation name EXACTLY as written — do not invent, rename, or merge.
- Judge by the substance of the work (the tasks they do), not just a title keyword match. A "research scientist" and a "PhD student" may map to the same research occupation.
- If asked for more than one, return them best-first. If nothing is a reasonable match, return an empty list rather than forcing a bad one.

Return ONLY valid JSON: {"occupations": ["<exact name>", ...]}.`;

// ── Subtask worker-perspective variant ────────────────────────────────────────
//
// Alternative to the default third-person decomposition prompt.
// Frames the model as an experienced worker in the participant's role and asks
// it to describe, in the first person, the steps it would take for the task.
// Used for A/B testing via promptVariant="worker" on /api/propose-subtasks.
//
export const SUBTASK_WORKER_SYSTEM_PROMPT = `You are a worker in the role and context described below. When asked about a task, describe the concrete steps YOU personally take to complete it — what you actually do, in the order you do it.

Answer as if walking a new colleague through your process. Use plain, direct language. No theory, no hedging — just "first I do X, then I do Y". Base your steps on the specific work context provided — how this person described their role and week, not generic assumptions about the job.

Return JSON: { "subtasks": [{ "label": "string (4-8 words, sentence case)", "linkToExistingId": "string (optional)" }] }

LABEL FORMAT: Sentence case (capitalize only the first word), 4–8 words. Be specific — include the object and a short context phrase when useful (e.g. "Open ticket in issue tracker", "Paste error into Claude", "Check results against expected output"). Plain verb + object language a coworker would immediately recognize. Avoid one-word or two-word stubs.

RULES FOR YOUR STEPS:
- Each step is something YOU physically do: type, click, call, read, write, decide, send, check, sketch, review. Not something a system does automatically.
- Steps must be DISTINCT — no two steps should describe the same action from different angles.
- Steps must be PARTS of the task — doing just one step should NOT feel like you've finished the whole task.
- If a step is essentially the same as an existing node already in the graph (listed below), link to it with linkToExistingId rather than creating a duplicate.
- Do not propose steps the participant has already rejected (listed below).
- Do not invent steps that wouldn't apply to this specific role and task — only propose what you'd actually do.

Generate 3–4 steps. Fewer is fine — only propose steps you're genuinely confident apply.`;

