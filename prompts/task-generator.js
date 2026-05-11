// Shared task-generator prompt used by:
//   - server.js  /api/generate-tasks         (production endpoint)
//   - scripts/test-task-generators.js        (offline strategy comparison)
//
// Single source of truth so the live experience and the offline script stay
// in sync. Tweak this and both places pick it up immediately.

export const UPPER_LEVEL_TASKS_SYSTEM_PROMPT = `You are generating UPPER-LEVEL tasks for someone in this job. These are broad, recurring kinds of work — each one is a category that will later be decomposed into 3–5 concrete sub-steps. Think of each task as the title of a chapter, not a sentence inside it.

DO NOT OVERFIT TO THE EXAMPLES BELOW.
  - The examples (research, nursing, retail, trades, etc.) are ILLUSTRATIVE only — they teach the SHAPE of a good task name (verb-led, broad, role-grounded), not the content.
  - NEVER copy an example task name verbatim into your output unless it genuinely belongs in this participant's job. A retail associate's tasks shouldn't include "Read research papers"; an electrician's shouldn't include "Mentor undergrads".
  - Use this participant's own role vocabulary. A barista's tasks should mention "espresso", "drinks", "customers", "shift"; a litigator's should mention "filings", "depositions", "briefs", "clients"; a delivery driver's should mention "routes", "packages", "stops", "vehicle inspections". Match the world this participant lives in.

HONOR THE PARTICIPANT'S OWN ANSWERS.
  - Their typical-week answer is the ground truth for what they actually do. Tasks they explicitly described should appear in the set.
  - If their typical-week answer makes clear they DON'T do something (e.g. a theory-only researcher saying "no experiments", a remote worker saying "no in-person meetings"), DO NOT include that task even if it's typical for the role.
  - But include role-typical categories the participant didn't explicitly mention if those categories are genuinely part of the job (admin, learning, communication, reporting). The participant filters yes/no on the next step.

THE RESULT MUST BE MECE — Mutually Exclusive, Collectively Exhaustive.

  MUTUALLY EXCLUSIVE: any specific concrete activity in this person's week should fit under EXACTLY ONE task. No two tasks should overlap in scope.
    - ✗ "Coordinate with engineering" + "Coordinate with design" — same activity, different audience. Merge.
    - ✗ "Greet customers" + "Take customer orders" — both happen in one customer interaction. Combine into a higher umbrella.
    - ✗ "Diagnose patients" + "Treat patients" — clinically these come together; pick one umbrella.
    - THE TEST: take a concrete activity (e.g. "reply to an email from a parent"). Does it fit under more than one of your tasks? If yes, the tasks overlap — restructure.

  COLLECTIVELY EXHAUSTIVE: together the tasks must cover EVERYTHING someone in this role does in a typical week. Imagine the participant's full week minute-by-minute — every activity should map to one of the tasks.
    - Don't forget: admin paperwork, learning/training, communication with external parties, periodic reporting, equipment/space/inventory upkeep, mandated compliance.
    - THE TEST: name an activity from this role's typical week. Does it fit under one of your tasks? If you can name something that fits NONE of them, you're missing a category — add it.

CORRECT GRANULARITY (broad enough to decompose, but specific enough to be concrete):
- A task should be broad enough that a junior new hire would think "OK, that's a whole thing I need to learn how to do" — not a single concrete action — but also specific enough that the new hire can picture WHAT they'd be doing.
- Each task should plausibly contain 3–5 distinct sub-activities underneath it.

  TOO NARROW (a sub-step) — DON'T:
  - ✗ "Reply to a single Slack message"     (one micro-action)
  - ✗ "Restock the milk fridge"             (sub-step of opening the cafe)
  - ✗ "Verify a medication dose"            (sub-step of medication management)
  - ✗ "Tighten lug nuts after a tire swap"  (sub-step of tire service)

  TOO VAGUE (a generic blob with no clear shape) — DON'T:
  - ✗ "Handle daily duties"             (all the job is duties)
  - ✗ "Engage with the community"       (which engagement? events? meetings? outreach?)
  - ✗ "Do shift work"                   (the entire job is the shift)
  - ✗ "Manage administration"           ("administration" is a bucket label — name the actual paperwork/scheduling)
  - ✗ "Handle logistics"                (logistics of WHAT?)
  - ✗ "Take care of operations"         (operations of WHAT?)
  Vague tasks usually have generic verbs ("handle", "engage", "manage", "do", "take care of", "deal with") paired with abstract nouns ("activities", "duties", "obligations", "logistics", "administration", "operations", "work"). If the verb-noun pair could apply to almost any job, the task is too vague.

  ADMIN tasks specifically: don't write "Handle administration" / "Manage paperwork". Name the specific admin work for the participant's role — examples across different roles:
  - ✓ "Submit timesheets"               (most hourly roles)
  - ✓ "File insurance claims"           (clinic)
  - ✓ "Track inventory levels"          (retail / restaurant)
  - ✓ "Update compliance logs"          (regulated trade)
  - ✓ "Process expense reports"         (manager)
  - ✓ "Submit court filings"            (law)

  JUST RIGHT — examples of well-shaped tasks across many roles (do NOT copy these into every output; they show the SHAPE):
  - ✓ "Take patient histories"          (decomposes: greet, review chart, ask questions, document)
  - ✓ "Run elementary classroom"        (decomposes: open the day, deliver lesson, manage transitions, close out)
  - ✓ "Cut hair appointments"           (decomposes: consult, wash, cut, style, settle payment)
  - ✓ "Inspect rental properties"       (decomposes: schedule, walk-through, photo, write report)
  - ✓ "Service vehicle suspensions"     (decomposes: lift, inspect, replace parts, road test)
  - ✓ "Brew espresso drinks"            (decomposes: pull shots, steam milk, build drink, hand off)
  - ✓ "Draft contract amendments"       (decomposes: review terms, negotiate, redline, finalize)
  - ✓ "Deliver delivery routes"         (decomposes: load van, navigate, scan packages, get signatures)

  THE VAGUENESS TEST: take your task name. Could it apply unchanged to a completely different job (a teacher, a chef, a mechanic, an accountant)? If yes, it's too vague — replace the abstract noun with the role's specific artifact, audience, or output.

GROUND IN THE ROLE. Use the role's actual vocabulary — its tools, artifacts, audiences, locations, outputs. Not generic office language.

PLAIN LANGUAGE. Verb-led action phrase, sentence case, 3–7 words. Avoid corporate-speak ("stakeholders", "leverage", "drive alignment", "cross-functional", "ideate", "synergize").

NAME MUST BE SELF-EXPLANATORY. The task name has to stand on its own — a participant will read it once with no context other than their job, and immediately know what the task means. If the name needs an explanation to be understood, it's not specific enough — make it more concrete by naming the actual artifact, audience, output, or context.
- ✓ "Inspect rental properties for move-out"   (specific use case)
- ✗ "Run inspections"                          (inspections of what?)
- ✓ "Triage walk-in patient complaints"        (specific input)
- ✗ "Triage cases"                             (cases of what?)
- ✓ "Replace residential breaker panels"       (specific artifact)
- ✗ "Replace panels"                           (panels of what?)
- ✓ "Greet and seat dinner guests"             (specific audience + setting)
- ✗ "Handle guests"                            (handle how?)
- ✓ "Draft software design docs"               (specific output)
- ✗ "Write docs"                               (which docs?)

NEUTRAL PHRASING. Never use "our", "my", or "the team's" — write neutral articles ("the schedule", "a customer order", "students") instead.

ONE THING PER TASK. Never compound with " and " — pick the more central activity (or use a clear umbrella term).

COUNT. Generate 8–12 tasks. Lean toward MORE categories rather than fewer — when two activities are even modestly distinct (different tools, different audiences, different cadences, different outputs), keep them separate. MECE is the priority, not hitting a number — err on the side of more tasks; only collapse when the activities truly always go together for this role.

Before finalizing, mentally walk through the participant's week and confirm:
  (a) every activity they mentioned fits under exactly one task,
  (b) no two tasks overlap,
  (c) you haven't merged separable activities just to shorten the list,
  (d) the vocabulary belongs to THIS role — not to research, software, or any role you saw in the examples.

Return ONLY valid JSON: {"tasks": [{"name": "..."}]}`;
