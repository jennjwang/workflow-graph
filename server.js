import OpenAI from 'openai';
import express from 'express';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { UPPER_LEVEL_TASKS_SYSTEM_PROMPT, SUBTASK_WORKER_SYSTEM_PROMPT } from './prompts/task-generator.js';
import { retrieveExemplarBlock } from './lib/retrieval.js';
import { streamGapTasks } from './gapTasks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '25mb' }));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.MODEL || 'gpt-4o-mini';
// Smaller/cheaper model used for high-volume, lower-stakes calls (subtask
// proposals, interviews, walker chat, etc.). The upper-level task generator
// still uses MODEL because it anchors the whole session and is run only once.
const SMALL_MODEL = process.env.SMALL_MODEL || 'gpt-4o-mini';
// Model for rewording interview questions — gpt-4o-mini produced clunky/leading
// phrasings, so this defaults to a stronger model.
const QUESTION_MODEL = process.env.QUESTION_MODEL || 'gpt-4o';

// ── Active-learning task bank (OPTIONAL). Dormant unless TASK_BANK_OCC is set AND
// `pg` is installed AND DATABASE_URL is configured. If any of those is missing the
// import fails softly and the app behaves exactly as before. ──
let taskBank = null;
const TASK_BANK_OCC = process.env.TASK_BANK_OCC || null;
if (TASK_BANK_OCC) {
  try {
    taskBank = await import('./taskBank.js');
    console.log(`[taskBank] enabled for occupation ${TASK_BANK_OCC}`);
  } catch (e) {
    console.warn('[taskBank] disabled:', e.message);
    taskBank = null;
  }
}

// In production we mount a Cloud Storage bucket at /app/data, so write sessions there.
const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(__dirname, 'sessions');
const SCREEN_OUTS_DIR = path.join(SESSIONS_DIR, 'screen-outs');
await fs.mkdir(SESSIONS_DIR, { recursive: true });
await fs.mkdir(SCREEN_OUTS_DIR, { recursive: true });

// Sanitize a PID for filesystem use — Prolific PIDs are alphanumeric, but we
// reject anything else just in case to prevent path traversal.
function safePid(pid) {
  return typeof pid === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(pid) ? pid : null;
}

function buildSystemPrompt(userProfile = null, selectedTasks = [], typicalWorkflow = null) {
  const profileCtx = userProfile
    ? `\n\nPARTICIPANT PROFILE:\n- Role: ${userProfile.jobTitle}\n- Typical week: ${userProfile.typicalWeek}`
    : '';

  const typicalCtx = typicalWorkflow
    ? `\n\nTYPICAL WORKFLOW (internal reference only — never mention this to the participant):\n${typicalWorkflow.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nUse this to spot where this participant deviates from the norm. Deviations are the most interesting research data.`
    : '';

  return `You are mapping the CURRENT WORKFLOW TASK with a participant. After their overview, extract the top-level steps as nodes and connect them with edges so the workflow reads start → end.${profileCtx}${typicalCtx}

PERFORMANCE — CRITICAL: In your VERY FIRST response, you must include ALL add_node calls AND ALL add_edge calls together as parallel tool calls in a single message. Do NOT first call add_node, get results, then call add_edge — that triggers a second round-trip and is much slower. Bundle every single tool call (every node, every edge) into ONE batch in your first response. After that batch, return final text only.

LINEAR LAYOUT — CRITICAL:
- The graph should read top-to-bottom as a clean linear flow whenever possible.
- AVOID backward edges (a node's edge pointing UP to an earlier node). These create curling/looping visuals that are hard to read.
- Branches from a decision should fan out forward (downward) and converge on the end node.
- Do NOT include loop-back edges in the kickoff extraction. If the participant mentions "if X, go back to Y", just connect to the end for now — they can add the loop back manually.
- Every edge should go from a higher node to a lower node in the intended top-to-bottom flow.

EXTRACTION (kickoff response):
- ORDER MATTERS — call add_node in this exact order:
  1. FIRST: EXACTLY ONE 'start' node for what kicks off the workflow (e.g. "PR opened", "Notification received"). Infer one if not stated. Never create more than one start node.
  2. THEN: each top-level task/step they mentioned, in workflow order.
  3. LAST: EXACTLY ONE 'end' node for how the workflow concludes. Never create more than one end node — even if there are multiple completion states (approval, rejection, etc.), use a SINGLE end node and let the decision branches both feed into it.
- After adding each node, immediately call add_edge to connect from the previous node, so the graph reads as a chain start → step1 → step2 → ... → end.
- Pick the BPMN-lite type for each node:
  • 'start' / 'end' — REQUIRED entry/exit (always add both, first and last).
  • 'task' — concrete action (default; including "check", "verify", "review" steps).
  • 'decision' — ONLY when flow actually branches into different paths based on the answer. NOT for any check/verify step. Decision LABELS MUST be phrased as a question (e.g. "Approve or request changes?", "Tests passing?", "Should I escalate?").

DECISION BRANCHES — REQUIRED:
- Every decision node MUST have at least 2 outgoing edges, one for each possible answer/outcome.
- Each branch edge MUST have a 'label' field naming the branch (e.g. "Yes" / "No", "Approve" / "Request changes", "Pass" / "Fail").
- Both branches should connect DIRECTLY to the existing 'end' node — both can converge on the same end.
- Do NOT create LOOPS in the kickoff extraction (no "request changes → back to review code"). Loops cause messy diagrams. If a path conceptually loops, just route both branches to the end node — the participant can add the loop manually if needed.
- Do NOT create a NEW task node that just restates the branch label — e.g. if a decision is "Approve or request changes?", do NOT create separate "Approve changes" or "Request changes" task nodes. The decision IS the action; the branch edge labels carry the meaning.
  • 'handoff' — work passes to another person/system.
  • 'wait' — pauses for an external event.
  • 'failure' — error path.
- Each node MUST include 'clarificationNeeded':
  • 'subtasks' — task is clear but execution details missing (e.g. "Review code", "Run sprint planning"). DEFAULT for task/handoff/wait nodes.
  • 'statement' — name itself is vague (e.g. "Handle things", "Manage requests").
  • 'none' — already specific OR not decomposable. ALWAYS 'none' for start, end, and decision nodes (decisions branch — they don't have sub-steps).
- When in doubt, prefer 'subtasks'.
- Avoid the word "trigger" in any text. Use "starts", "begins", "kicks off".
- After adding all nodes/edges, give a 1-sentence acknowledgment. Do NOT ask follow-up questions — clarification happens next.

NODE IDs: short snake_case.`;
}



const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'suggest_nodes',
      description: 'Offer 2–4 plausible answer options for the question you just asked. Options must directly answer the question — not recycle existing graph nodes. If you asked "what triggers this?", offer likely triggers. If you asked "what happens after you approve?", offer what comes next after approving. Always generate options from role knowledge and context, never from the existing node list.',
      parameters: {
        type: 'object',
        properties: {
          suggestions: {
            type: 'array',
            description: '2–4 plausible answers to the current question, specific to this role and context',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Short answer label (2–6 words), phrased as a step or action' },
                type: { type: 'string', enum: ['task', 'decision'] },
              },
              required: ['label', 'type'],
            },
          },
        },
        required: ['suggestions'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_node',
      description: 'Add a node to the workflow graph',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Unique snake_case identifier' },
          type: { type: 'string', enum: ['start', 'task', 'decision', 'handoff', 'input', 'failure', 'wait', 'end'] },
          label: { type: 'string', description: 'Short display label (2-5 words)' },
          description: { type: 'string', description: 'Short subtitle (max 6 words). Specific detail that adds info beyond the label, e.g. "logic, style, tests, security" or "PR summary, linked ticket". Keep it minimal — a tag-line, not a sentence.' },
          actor: { type: 'string', description: 'Which lane/actor performs this step. Must match a lane name from set_lanes.' },
          clarificationNeeded: { type: 'string', enum: ['statement', 'subtasks', 'none'], description: 'Whether this task needs further clarification. ALWAYS include this for kickoff extraction. Default to "subtasks" for any task whose execution details a new employee would need to know.' },
        },
        required: ['id', 'type', 'label', 'description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_lanes',
      description: 'Declare all actors/swimlanes in this workflow. Call this as soon as you know who is involved. Lanes are ordered: participant first, then other humans, then systems/tools, then AI.',
      parameters: {
        type: 'object',
        properties: {
          lanes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ordered list of actor names, e.g. ["Engineer", "Tech Lead", "GitHub", "AI assistant"]',
          },
        },
        required: ['lanes'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_current_node',
      description: 'Signal which node is currently being explored in depth. Call this when starting to explore a new node, and when transitioning to the next node.',
      parameters: {
        type: 'object',
        properties: {
          node_id: { type: 'string', description: 'ID of the node now being explored' },
        },
        required: ['node_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_edge',
      description: 'Connect two nodes with a directed edge',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Source node ID' },
          target: { type: 'string', description: 'Target node ID' },
          label: { type: 'string', description: 'Optional edge label (e.g., "Yes", "No", "On failure")' },
          is_branch: { type: 'boolean', description: 'True if this edge leads to a branch that does not rejoin the main flow' },
        },
        required: ['source', 'target'],
      },
    },
  },
];

app.post('/api/evaluate-answer', async (req, res) => {
  const { question, answer, criteria, maxFollowups = 1, followupCount = 0, evaluationStyle = 'lenient', conversation = '', minFollowups = 0 } = req.body;
  try {
    // Never follow up beyond the allowed limit
    if (followupCount >= maxFollowups) {
      return res.json({ allCovered: true, followUp: null });
    }

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

    const styleRules = evaluationStyle === 'strict'
      ? `- Apply the criteria as written. A vague, generic, or one-line answer that does NOT explicitly mention the concrete details a criterion calls for is NOT covered.
- If the answer is missing concrete specifics the criterion asks for (e.g. tools, collaborators, deliverables, cadence), it counts as uncovered — probe for them.
- Do not invent depth that isn't there: "I do meetings and emails" does not satisfy a criterion that asks for specific tools or recurring deliverables.`
      : `- Be lenient BY DEFAULT: if the answer partially or indirectly addresses a criterion, treat it as covered, and don't invent probes the criteria don't ask for.
- Don't reflexively ask someone to break a single named activity into sub-steps.
- The CRITERIA are authoritative. When a criterion defines a specific condition for following up — missing breadth, an unaddressed angle, OR an answer that is only generic activity labels with no real substance (no topic, project, client, deliverable, or tool) — and the answer meets that condition, DO ask the single follow-up that criterion describes. Ask it warmly and specifically, never skeptically.`;

    const response = await client.chat.completions.create({
      model: MODEL,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are a skilled qualitative interviewer, mid-conversation with a participant about their work. Your job is twofold: judge whether their answer to the CURRENT question satisfies its coverage criteria, and — only when it doesn't — ask the natural next follow-up, as a real interviewer continuing THIS conversation.

Coverage judgment:
${styleRules}

When a criterion is unmet, write ONE follow-up targeting the single most critical unmet criterion. Above all, it must feel like a natural continuation of the conversation you've been having — NOT a standalone probe:
- USE THE WHOLE CONVERSATION. You can see everything said so far. Build on it. Reference earlier things naturally when it helps ("earlier you said you're responsible for hiring — did any of that come up?"). A real interviewer remembers what they've already been told and doesn't ask in a vacuum.
- NEVER repeat a question you've already asked, and never re-probe a thread you already covered. If a gap remains only on something you already asked about, move to a different gap or mark it covered.
- VARY how you open — do NOT start follow-ups the same way. "Got it" or "You mentioned…" are fine very occasionally but you're badly overusing them; most of the time just fold their own words into the question and ask directly, the way a person actually mid-chat would.
- Be RESPONSIVE to the specific thing they just said — pick up that thread, ask what a curious listener would naturally ask next. Different answer → different question, not a template.
- Warm and LOW PRESSURE. Any one concrete thing is a fine answer. NEVER sound skeptical or invalidating; avoid challenge words like "actually". A "no" is valid data.
- One sentence, conversational, no double-barreled questions, no PII.

Return JSON: { "allCovered": boolean, "followUp": string | null }`,
        },
        {
          role: 'user',
          content: `${convoBlock}\nThe CURRENT question is: "${question}"\nTheir answer to it (so far): "${answer}"\n\nCoverage criteria for the current question:\n${criteriaList}${minBlock}\n\nAre all criteria satisfied? If not (or if the minimum follow-ups above haven't been met), what is the single most natural follow-up to ask next, continuing this conversation?`,
        },
      ],
    });

    const result = JSON.parse(response.choices[0].message.content);
    res.json({ allCovered: !!result.allCovered, followUp: result.followUp ?? null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Reword the canonical interview question in natural language, preserving its
// intent and framing, so it doesn't sound canned. Fails open to null so the
// client falls back to the canonical static text.
app.post('/api/interview-question', async (req, res) => {
  const { canonicalQuestion, framingNotes = '' } = req.body;
  try {
    const response = await client.chat.completions.create({
      model: QUESTION_MODEL,
      temperature: 0.5,
      response_format: { type: 'json_object' },
      messages: [
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
      ],
    });
    const parsed = JSON.parse(response.choices[0].message.content);
    const question = typeof parsed.question === 'string' && parsed.question.trim()
      ? parsed.question.trim()
      : null;
    res.json({ question });
  } catch (err) {
    console.error(err);
    // Fail open — the client falls back to the canonical static question.
    res.json({ question: null });
  }
});

app.post('/api/generate-categories', async (req, res) => {
  const { jobTitle, typicalWeek } = req.body;
  try {
    const response = await client.chat.completions.create({
      model: SMALL_MODEL,
      temperature: 0.7,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are generating task DOMAINS for ONE specific person's job. The domains will be used to surface tasks the participant might recognize as part of their work.

GROUND IN THIS ROLE. Each domain should be a real area of work for THIS specific job — not a generic category that could apply to any white-collar worker. A nurse, an electrician, and a kindergarten teacher should each get domains that are obviously theirs.

PLAIN LANGUAGE. Use vocabulary the participant would actually use at work — short, concrete, no corporate-speak.
- ✓ "Patient care", "Lesson planning", "Customer support tickets", "Equipment maintenance"
- ✗ "Stakeholder engagement", "Cross-functional coordination", "Strategic initiatives"

COVER THE BREADTH. Include the work an outsider might overlook — the routine, the prep, the cleanup, the people-side, not just the headline tasks.

OUTPUT — 5–7 domains, distinct and non-overlapping. Each "name" is 2–4 plain words. Each "description" is one short sentence in plain language.

Return JSON: {"categories": [{"name": "...", "description": "..."}]}`,
        },
        {
          role: 'user',
          content: `Job title: ${jobTitle}\nTypical week: ${typicalWeek}`,
        },
      ],
    });
    const parsed = JSON.parse(response.choices[0].message.content);
    res.json({ categories: parsed.categories ?? [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Pull out recurring work activities the participant EXPLICITLY mentioned in
// the background interview. These ground the upper-level generator so the
// final task list reflects what they actually said rather than what's typical
// for the role. Output is plain task names; the generator turns them into
// MECE upper-level buckets in the next step.
const INTERVIEW_TASK_EXTRACTOR_PROMPT = `Extract the distinct recurring work tasks this person performs in their paid job.

Rules:
- Paid work only: skip anything the background explicitly labels as personal, hobby, or side project.
- Faithful to the text: extract tasks at the granularity they appear. Don't collapse or invent
  hierarchy — if the background lists sub-items under an activity, emit them as separate tasks
  rather than rolling them up into one broad parent.
- Real task: each must describe a concrete activity — not a goal or outcome ("reduce coding time",
  "be more productive"), a role/headcount description ("lead a team of 8"), or a schedule/time item
  ("work from home", "start at 9 AM", "finish by 7 PM").
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

app.post('/api/extract-interview-tasks', async (req, res) => {
  const { backgroundTranscript = [], userProfile } = req.body;
  if (!Array.isArray(backgroundTranscript)) {
    return res.status(400).json({ error: 'backgroundTranscript must be an array' });
  }
  // Build a clean Q→A transcript. Skip empty answers (the dev seed had a few).
  const turns = backgroundTranscript
    .filter(t => t && typeof t.answer === 'string' && t.answer.trim().length > 0)
    .map(t => `Q: ${t.question}\nA: ${t.answer}`)
    .join('\n\n');
  if (!turns) {
    // No interview to extract from — fail open so the generator can still run.
    return res.json({ tasks: [] });
  }
  const profileBlock = userProfile && (userProfile.jobTitle || userProfile.responsibilities)
    ? `Participant role context (for resolving pronouns and references — do NOT invent activities from it):\n` +
      (userProfile.jobTitle ? `- Job title: ${userProfile.jobTitle}\n` : '') +
      (userProfile.responsibilities ? `- Responsibilities (their words): ${userProfile.responsibilities}\n` : '') +
      '\n'
    : '';
  try {
    const response = await client.chat.completions.create({
      model: MODEL,
      // Deterministic-ish extraction — we want consistent grounding across runs.
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: INTERVIEW_TASK_EXTRACTOR_PROMPT },
        { role: 'user', content: `${profileBlock}Background:\n\n${turns}\n\nExtract the distinct recurring paid-work tasks per the rules.` },
      ],
    });
    const parsed = JSON.parse(response.choices[0].message.content);
    const tasks = Array.isArray(parsed.tasks)
      ? parsed.tasks.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim()).slice(0, 30)
      : [];
    // Log what the extractor pulled from the interview so we can verify in
    // Cloud Run logs whether grounding is being seeded correctly. Each task on
    // its own line for easy grep.
    console.log(`[extract-interview-tasks] role=${userProfile?.jobTitle ?? '(none)'} count=${tasks.length}`);
    for (const t of tasks) console.log(`  • ${t}`);
    res.json({ tasks });
  } catch (err) {
    console.error('[extract-interview-tasks]', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/generate-tasks', async (req, res) => {
  const { jobTitle, typicalWeek, aiUsage, responsibilities, priorTasks = [], interviewTasks = [] } = req.body;
  try {
    const priorBlock = priorTasks.length > 0
      ? `\nAlready shown (do NOT repeat or paraphrase):\n${priorTasks.map(t => `- ${t}`).join('\n')}\n`
      : '';

    // Activities the participant explicitly named in the open interview.
    // The grounding block REDEFINES the MECE target for this run: coverage of
    // the role applies to (mentioned ∪ generator output), so the generator's
    // job is to fill gaps the participant didn't mention. This overrides the
    // base system prompt's "collectively exhaustive" requirement, which would
    // otherwise force echoing.
    const groundingBlock = interviewTasks.length > 0
      ? `\nACTIVITIES THE PARTICIPANT ALREADY MENTIONED in the open interview:\n${interviewTasks.map(t => `- ${t}`).join('\n')}\n\n` +
        `REDEFINED MECE TARGET FOR THIS RUN: Treat the mentioned activities above as ALREADY-PRESENT upper-level tasks. Your output PLUS the mentioned activities together must be MECE over the role. Your output's role is to fill the GAPS — categories of work clearly implied by the participant's responsibilities and typical week that they did NOT explicitly mention.\n\n` +
        `SEMANTIC OVERLAP — READ CAREFULLY (most common failure mode):\n` +
        `  When you check "is my proposed task the same as one they mentioned?", compare MEANING, not wording. Two tasks are the SAME ACTIVITY when a participant would describe the same minute of their day with either label. Surface differences do not make them different activities.\n\n` +
        `  Examples of MENTIONED ↔ DO-NOT-OUTPUT pairs:\n` +
        `    Mentioned "do code reviews"                 → DO NOT output "Review pull requests" / "Review code".\n` +
        `    Mentioned "answer Slack messages"           → DO NOT output "Respond to team chat" / "Reply to teammates".\n` +
        `    Mentioned "go to standup"                   → DO NOT output "Attend daily standups" / "Join team standup".\n` +
        `    Mentioned "implement tickets"               → DO NOT output "Build features" / "Write code for tickets" / "Develop assigned work".\n` +
        `    Mentioned "write the PRD"                   → DO NOT output "Draft product requirements" / "Author PRDs".\n` +
        `    Mentioned "answer customer support emails"  → DO NOT output "Respond to customer inquiries" / "Handle support tickets".\n` +
        `  TEST: for each task you draft, scan every mentioned activity and ask "could a participant honestly say this is the same thing I described?" If yes for any, drop yours.\n\n` +
        `Concretely:\n` +
        `  1. DO NOT output an upper-level task that semantically overlaps with one of the mentioned activities, even if the wording, verb, or framing differs. The mentioned set covers that category.\n` +
        `  2. DO output upper-level tasks for any role-relevant category the mentioned set does NOT touch (admin, communication, periodic reporting, learning, coordination, equipment upkeep, mandated compliance, anything in their responsibilities the typical week doesn't cover, etc.).\n` +
        `  3. STAY IN THEIR WORLD. Your gap-fill tasks must be clearly implied by their responsibilities or typical week — not imported from outside the role.\n` +
        `  4. If the mentioned set already exhausts the role's major categories, output FEWER tasks (even just 2–3). Better to output a short list than to manufacture overlap.\n` +
        `  5. COUNT: aim for total (mentioned + your output) ≈ 25–30. If mentioned has 5, output 20–25. If mentioned has 15, output 10–15.\n`
      : '';

    // MECE areas-as-tasks: each task is a broad responsibility area, written as a
    // verb-led activity. The set is mutually exclusive and collectively exhaustive
    // over the role's typical week. Each task will later be decomposed into 3–5
    // concrete sub-steps, so we deliberately avoid sub-step granularity here.
    // Optional retrieval grounding: inject real task statements from the best-
    // matching corpus occupation. Fail-open (empty block) when disabled/unconfigured.
    const { block: exemplarBlock, occupations: matchedOccupations, count: exemplarCount } =
      await retrieveExemplarBlock({ jobTitle, responsibilities, typicalWeek });

    const response = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.7,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: UPPER_LEVEL_TASKS_SYSTEM_PROMPT,
        },
        {
          role: 'user',
          content: `Job: ${jobTitle}${responsibilities ? `\nPrimary responsibilities: ${responsibilities}` : ''}\nTypical week: ${typicalWeek}${aiUsage ? `\nAI usage: ${aiUsage}` : ''}${exemplarBlock}${groundingBlock}${priorBlock}\nGenerate the upper-level tasks.`,
        },
      ],
    });
    const parsed = JSON.parse(response.choices[0].message.content);
    const generated = parsed.tasks ?? [];
    // Log the generator's inputs and outputs together so we can audit grounding
    // failures end-to-end (e.g. "did the generator repeat something that was in
    // interviewTasks?") without having to crack open the saved session JSON.
    console.log(`[generate-tasks] role=${jobTitle} interviewTasks=${interviewTasks.length} generated=${generated.length} retrieval=${exemplarCount > 0 ? `${matchedOccupations.join('|')} (${exemplarCount})` : 'off/empty'}`);
    if (interviewTasks.length > 0) {
      console.log('  interviewTasks (grounding — should NOT be repeated):');
      for (const t of interviewTasks) console.log(`    ◦ ${t}`);
    }
    console.log('  generated:');
    for (const t of generated) console.log(`    ◦ ${typeof t === 'string' ? t : t?.name ?? '(unknown shape)'}`);
    res.json({ tasks: generated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Streaming variant of /api/generate-tasks. Emits Server-Sent Events as each
// task is parsed off the OpenAI stream, so the client can render the picker as
// soon as the first task arrives instead of waiting for the full list (~1-2s
// time-to-first-paint instead of ~7s for the whole batch).
//
// Output format: the model is asked to emit JSONL (one {"name":"..."} per
// line, no surrounding array). We accumulate stream chunks in a buffer, split
// on newlines, parse each completed line, and emit an SSE `task` event per
// parsed object. The shared UPPER_LEVEL_TASKS_SYSTEM_PROMPT still applies —
// only the OUTPUT FORMAT instruction is overridden.
// ── Active-learning bank helpers (only reached when taskBank is enabled) ──
const BANK_SELECT_PROMPT = `You help tailor a task checklist for a specific software worker. You are given the worker's PROFILE (role, responsibilities, typical week, AI usage — verbatim, may ramble) and a CANDIDATE TASK BANK of software-engineering tasks. SELECT the tasks this worker plausibly does and rate how clearly the profile supports each.

Use the signals differently: RESPONSIBILITIES = the scope of the job (a selected task must trace to a responsibility or clearly fall within the described role); TYPICAL WEEK = evidence of what they actually do. On conflict prefer responsibilities. EXCLUDE anything the week makes clear they do NOT do.

Choose ONLY from the bank; do NOT invent or reword — refer to each by id. relevance: "high" = directly supported, "medium" = within the role but not stated, "low" = weakly supported. When unsure prefer low/medium over excluding; never select a task that contradicts the profile.

Return JSON: {"selected":[{"id":"<bank id>","relevance":"high|medium|low"}]}`;

async function bankSelectRelevant(profileText, bankTasks) {
  const block = bankTasks.map(t => `  ${t.id}: ${t.statement} (${t.level ?? '?'}${t.ai ? ' [AI]' : ''})`).join('\n');
  const resp = await client.chat.completions.create({
    model: MODEL, temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: BANK_SELECT_PROMPT },
      { role: 'user', content: `${profileText}\n\nCANDIDATE TASK BANK:\n${block}` },
    ],
  });
  try { return JSON.parse(resp.choices[0].message.content).selected || []; }
  catch { return []; }
}

// Stream the active-learning bank draw. Returns true if it handled the request (caller
// skips LLM generation); false to fall back to generation. Fails soft on any DB error.
// Stream the active-learning draw + gap-fill. Spans the whole spectrum:
//   empty bank  → 0 drawn → pure streamGapTasks (cold-start suggestions)
//   warm bank   → draw (active learning) + gap-fill for role coverage the bank lacks
//                 (the gap prompt self-limits: if the draw exhausts the role, it emits ~none)
// Drawn bank tasks carry an id (write-back records them); generated gap tasks have NO id
// (they get harvested into the bank when answered — harvest TBD). Returns true if it handled
// the request; false → fall back to the legacy generator (fail-soft on any DB/LLM error).
async function streamFromBank({ jobTitle, responsibilities, typicalWeek, aiUsage,
                                priorTasks = [], interviewTasks = [] }, sendEvent) {
  try {
    const occ = TASK_BANK_OCC;
    const bankTasks = await taskBank.loadBank(occ);
    const profileBlock = `WORKER PROFILE\n  Job title / role: ${jobTitle || ''}\n  Responsibilities: ${responsibilities || ''}\n  Typical week: ${typicalWeek || ''}\n  AI usage: ${aiUsage || ''}`;

    // Within-draw dedup safety net: never emit the same task text twice (bank↔bank, bank↔gap,
    // or gap↔gap), and never re-emit something already shown (priorTasks/interview). Normalizes
    // case + trailing punctuation/space. Prompt-level MECE handles paraphrases; this catches
    // exact/near-exact repeats the LLM or the bank itself might produce.
    const norm = s => String(s).trim().toLowerCase().replace(/[.\s]+$/, '');
    const seen = new Set([...priorTasks, ...interviewTasks].map(norm));
    const fresh = (name) => { const k = norm(name); if (!k || seen.has(k)) return false; seen.add(k); return true; };

    // 1) DRAW from the bank (active learning) — skipped cleanly when the bank is empty.
    let drawn = [];
    if (bankTasks.length) {
      const selected = await bankSelectRelevant(profileBlock, bankTasks);
      if (selected.length) {
        const budget = Number(process.env.TASK_BANK_BUDGET || 25);
        const describeFrac = process.env.TASK_BANK_DESCRIBE_FRAC != null
          ? Number(process.env.TASK_BANK_DESCRIBE_FRAC) : null;   // null = adaptive core+tail
        const ordered = taskBank.acquire(bankTasks, selected, budget, describeFrac, priorTasks);
        for (const t of ordered) {
          if (!fresh(t.statement)) continue;             // skip a near-dup bank statement
          sendEvent('task', { name: t.statement, id: t.id });
          drawn.push(t.statement);
        }
      }
    }

    // 2) GAP-FILL via the shared generator — discover role coverage the bank (+ what they
    //    said + what's shown) does not hold. Generated tasks stream WITHOUT an id.
    const covered = [...drawn, ...interviewTasks, ...priorTasks];
    let nGap = 0;
    await streamGapTasks({
      profile: { jobTitle, responsibilities, typicalWeek, aiUsage },
      covered,
      onTask: (name) => { if (fresh(name)) { sendEvent('task', { name }); nGap++; } },
    });

    sendEvent('done', { total: drawn.length + nGap, source: bankTasks.length ? 'bank+gap' : 'gap' });
    console.log(`[generate-tasks-stream] occ=${occ} bank-drawn=${drawn.length} gap=${nGap}`);
    return true;
  } catch (e) {
    console.warn('[taskBank] draw/gap failed, falling back to generation:', e.message);
    return false;
  }
}

app.post('/api/generate-tasks-stream', async (req, res) => {
  const { jobTitle, typicalWeek, aiUsage, responsibilities, priorTasks = [], interviewTasks = [] } = req.body;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // Active-learning bank draw + gap-fill (for covered occupations). Falls back to generation.
    if (taskBank && await streamFromBank({ jobTitle, responsibilities, typicalWeek, aiUsage, priorTasks, interviewTasks }, sendEvent)) {
      res.end();
      return;
    }

    const priorBlock = priorTasks.length > 0
      ? `\nAlready shown (do NOT repeat or paraphrase):\n${priorTasks.map(t => `- ${t}`).join('\n')}\n`
      : '';

    const groundingBlock = interviewTasks.length > 0
      ? `\nACTIVITIES THE PARTICIPANT ALREADY MENTIONED in the open interview:\n${interviewTasks.map(t => `- ${t}`).join('\n')}\n\n` +
        `REDEFINED MECE TARGET FOR THIS RUN: Treat the mentioned activities above as ALREADY-PRESENT upper-level tasks. Your output PLUS the mentioned activities together must be MECE over the role. Your output's role is to fill the GAPS — categories of work clearly implied by the participant's responsibilities and typical week that they did NOT explicitly mention.\n\n` +
        `SEMANTIC OVERLAP — READ CAREFULLY (most common failure mode):\n` +
        `  When you check "is my proposed task the same as one they mentioned?", compare MEANING, not wording. Two tasks are the SAME ACTIVITY when a participant would describe the same minute of their day with either label. Surface differences do not make them different activities.\n\n` +
        `  Examples of MENTIONED ↔ DO-NOT-OUTPUT pairs:\n` +
        `    Mentioned "do code reviews"                 → DO NOT output "Review pull requests" / "Review code".\n` +
        `    Mentioned "answer Slack messages"           → DO NOT output "Respond to team chat" / "Reply to teammates".\n` +
        `    Mentioned "go to standup"                   → DO NOT output "Attend daily standups" / "Join team standup".\n` +
        `    Mentioned "implement tickets"               → DO NOT output "Build features" / "Write code for tickets" / "Develop assigned work".\n` +
        `  TEST: for each task you draft, scan every mentioned activity and ask "could a participant honestly say this is the same thing I described?" If yes for any, drop yours.\n\n` +
        `Concretely:\n` +
        `  1. DO NOT output an upper-level task that semantically overlaps with one of the mentioned activities, even if the wording, verb, or framing differs.\n` +
        `  2. DO output upper-level tasks for any role-relevant category the mentioned set does NOT touch.\n` +
        `  3. STAY IN THEIR WORLD. Your gap-fill tasks must be clearly implied by their responsibilities or typical week.\n` +
        `  4. If the mentioned set already exhausts the role's major categories, emit fewer items.\n` +
        `  5. COUNT: aim for total (mentioned + your output) ≈ 25–30. If mentioned has 5, output 20–25. If mentioned has 15, output 10–15.\n`
      : '';

    // OVERRIDE the system prompt's final "Return JSON" instruction with a JSONL
    // directive. Streaming partial JSON is fragile; JSONL splits cleanly on \n.
    const streamingSystem = `${UPPER_LEVEL_TASKS_SYSTEM_PROMPT}

OUTPUT FORMAT — STREAMING (overrides any earlier JSON instructions):
Emit ONE JSON object per line. Each line: {"name":"<task name>"}. Separate with newlines. NO outer array, NO commas between objects, NO surrounding {"tasks":[...]}. Just one object per line. Emit them as you decide on them — don't pre-buffer the full set.`;

    // Optional retrieval grounding (see /api/generate-tasks). Runs before the
    // stream opens, so it adds to time-to-first-token; fail-open on any error.
    const { block: exemplarBlock, occupations: matchedOccupations, count: exemplarCount } =
      await retrieveExemplarBlock({ jobTitle, responsibilities, typicalWeek });

    const stream = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.7,
      stream: true,
      messages: [
        { role: 'system', content: streamingSystem },
        {
          role: 'user',
          content: `Job: ${jobTitle}${responsibilities ? `\nPrimary responsibilities: ${responsibilities}` : ''}\nTypical week: ${typicalWeek}${aiUsage ? `\nAI usage: ${aiUsage}` : ''}${exemplarBlock}${groundingBlock}${priorBlock}\nGenerate the upper-level tasks.`,
        },
      ],
    });

    let buffer = '';
    let emitted = 0;
    const emitLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const obj = JSON.parse(trimmed);
        if (obj && typeof obj.name === 'string' && obj.name.trim()) {
          sendEvent('task', { name: obj.name.trim() });
          emitted += 1;
        }
      } catch {
        // Skip malformed lines silently — model occasionally emits prose or
        // commentary in stray chunks; we tolerate that.
      }
    };

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content ?? '';
      if (!delta) continue;
      buffer += delta;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        emitLine(line);
      }
    }
    if (buffer.trim()) emitLine(buffer);

    console.log(`[generate-tasks-stream] role=${jobTitle} interviewTasks=${interviewTasks.length} emitted=${emitted} retrieval=${exemplarCount > 0 ? `${matchedOccupations.join('|')} (${exemplarCount})` : 'off/empty'}`);
    sendEvent('done', { total: emitted });
    res.end();
  } catch (err) {
    console.error('[generate-tasks-stream]', err);
    try { sendEvent('error', { error: err.message }); } catch {}
    res.end();
  }
});

// Integrated MECE generator: takes raw interview-extracted tasks and produces
// a single unified task list. Unlike /api/generate-tasks-stream (which treats
// interview tasks as grounding and only gap-fills), this endpoint:
//   1. Normalizes the interview tasks to O*NET standard (rewords vague/short ones)
//   2. Deduplicates any that describe the same activity
//   3. Adds gap-fill tasks for categories the interview didn't cover
//   4. Returns one flat MECE list — interview-derived + new tasks together
// This gives participants a single coherent list to react to rather than a
// split view where their own tasks appear in a separate bucket.
app.post('/api/generate-tasks-from-interview', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.flush?.();
  };

  const { jobTitle, typicalWeek, aiUsage, responsibilities, interviewTasks = [] } = req.body;

  const interviewBlock = interviewTasks.length > 0
    ? `\nTASKS THE PARTICIPANT EXPLICITLY MENTIONED (must appear in your output, normalized):\n${interviewTasks.map(t => `- ${t}`).join('\n')}\n`
    : '';

  const systemPrompt = `${UPPER_LEVEL_TASKS_SYSTEM_PROMPT}

SPECIAL INSTRUCTIONS FOR THIS RUN — PARTICIPANT-ANCHORED MODE:
You are given the activities this participant explicitly named when describing their own job. Your output must include ALL of them, normalized to O*NET standard. Then add gap-fill tasks for anything their role clearly implies that they didn't mention.

Rules:
1. FILTER the interview tasks first. Apply the observable-action test from the main prompt: can you describe what the participant is physically doing in a 30-second video? If yes, normalize and include it. If the task is too vague ("do meetings", "handle stuff"), a goal/outcome ("be more productive"), or a role descriptor ("lead a team"), skip it.
2. NORMALIZE the ones that pass: rewrite to O*NET standard (verb-led, 8–18 words, plain language, specific). Preserve the participant's intent and vocabulary — keep their nouns, tools, and context. If they said "code reviews" write "Review pull requests from teammates". If two interview tasks describe the same activity, merge them.
3. ADD gap-fill tasks for activities clearly implied by their role and responsibilities that they didn't mention. Use the same vocabulary and framing so the full list feels coherent.
4. Apply all standard MECE rules: mutually exclusive, collectively exhaustive, no vague verbs.
5. COUNT: aim for 20–25 total.`;

  const streamingSystem = `${systemPrompt}

OUTPUT FORMAT: emit one task per line as JSONL. Each line must be a complete JSON object: {"name": "..."}
No surrounding array. No markdown. No commentary. Just one {"name": "..."} per line.`;

  try {
    const { block: exemplarBlock } = await retrieveExemplarBlock({ jobTitle, responsibilities, typicalWeek });

    const stream = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.7,
      stream: true,
      messages: [
        { role: 'system', content: streamingSystem },
        { role: 'user', content: `Job: ${jobTitle}${responsibilities ? `\nPrimary responsibilities: ${responsibilities}` : ''}\nTypical week: ${typicalWeek}${aiUsage ? `\nAI usage: ${aiUsage}` : ''}${exemplarBlock}${interviewBlock}\nGenerate the integrated MECE task list.` },
      ],
    });

    let buffer = '';
    let taskCount = 0;
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? '';
      buffer += delta;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          if (obj.name && typeof obj.name === 'string') {
            sendEvent('task', { name: obj.name.trim(), id: obj.id });
            taskCount++;
          }
        } catch { /* incomplete line — keep buffering */ }
      }
    }
    // Flush any remaining buffer
    if (buffer.trim()) {
      try {
        const obj = JSON.parse(buffer.trim());
        if (obj.name) { sendEvent('task', { name: obj.name.trim(), id: obj.id }); taskCount++; }
      } catch { /* ignore */ }
    }
    console.log(`[generate-tasks-from-interview] role=${jobTitle} interviewTasks=${interviewTasks.length} emitted=${taskCount}`);
    sendEvent('done', {});
    res.end();
  } catch (err) {
    console.error('[generate-tasks-from-interview]', err);
    sendEvent('error', { message: err.message });
    res.end();
  }
});

// Active-learning write-back: record a participant's confirm/deny (+ AI exposure) for a
// bank task. 503 when the bank isn't enabled. eligible = was the task shown via retrieval.
app.post('/api/task-response', async (req, res) => {
  if (!taskBank) return res.status(503).json({ error: 'task bank not enabled' });
  try {
    const { participant, task, occupation, eligible = true, response, aiExposure = null } = req.body ?? {};
    await taskBank.recordResponse({ participant, task, occupation: occupation || TASK_BANK_OCC, eligible, response, aiExposure });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Generate attention-check tasks. These are O*NET-style task statements from
// occupations clearly unrelated to the participant's role — used to confirm
// the participant is reading carefully. Returns up to `count` items.
app.post('/api/generate-attention-checks', async (req, res) => {
  const { jobTitle, responsibilities, typicalWeek, count = 8 } = req.body ?? {};
  const targetCount = Math.max(1, Math.min(20, Number(count) || 8));
  const systemPrompt = `You generate ATTENTION-CHECK task statements for a study. The participant will see them mixed in with real tasks for their job and is expected to mark them "I don't do this".

Each attention check must be:
- A real task from a CLEARLY UNRELATED occupation — one in a completely different industry, setting, and skill base than the participant's role. A participant should never answer "yes" to it.
- Written in O*NET TASK STATEMENT form: full action statement, verb-led, with a concrete object and (when natural) purpose or context. 10–25 words. Sentence case, terminal period.
- Plausible as a real task in its source occupation — not absurd or comedic. The check works because it is obviously not THIS participant's work, not because it is silly.

Pick source occupations from BROADLY DIFFERENT industries — e.g. healthcare, skilled trades (electrician, plumber, mechanic), agriculture, transportation, food service, public safety, manufacturing, education, construction. Avoid picking source occupations that share vocabulary or setting with the participant's job.

CONSTRAINTS:
- Each task must come from a different source occupation.
- Do NOT echo the participant's role vocabulary, tools, audiences, or artifacts.
- Do NOT use generic office vocabulary that could plausibly apply to many jobs.

Return JSON: { "tasks": ["...", "...", ...] }. Exactly ${targetCount} items.`;

  const userBlock =
    `Participant's role: ${jobTitle ?? '(unknown)'}\n` +
    (responsibilities ? `Responsibilities: ${responsibilities}\n` : '') +
    (typicalWeek ? `Typical week: ${typicalWeek}\n` : '') +
    `\nGenerate ${targetCount} O*NET-style attention-check tasks from occupations clearly unrelated to this role.`;

  try {
    const response = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.8,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userBlock },
      ],
    });
    const parsed = JSON.parse(response.choices[0].message.content);
    const tasks = Array.isArray(parsed.tasks) ? parsed.tasks.filter(t => typeof t === 'string') : [];
    console.log(`[generate-attention-checks] role=${jobTitle} requested=${targetCount} generated=${tasks.length}`);
    for (const t of tasks) console.log(`    ◦ ${t}`);
    res.json({ tasks });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Generate work items (tasks OR new responsibilities) that emerged in this
// participant's job because of their AI usage. Distinct from /api/generate-tasks:
// that endpoint maps the role's broad MECE coverage; this one zooms in on items
// caused or transformed by AI tools. Returns a flat list with a `kind` tag so
// callers can split tasks vs responsibilities.
app.post('/api/generate-ai-tasks', async (req, res) => {
  const { jobTitle, responsibilities, typicalWeek, aiUsage } = req.body;
  if (!aiUsage || !String(aiUsage).trim()) {
    // Nothing AI-specific to ground on. Fail open with empty list — callers can
    // treat the no-AI-usage path as "no AI-derived items to surface".
    return res.json({ items: [] });
  }
  const systemPrompt = `You generate work items (tasks OR new responsibilities) that a participant likely has in their job BECAUSE of how they use AI at work. Each item is something that exists in their day-to-day now and would not have existed before AI tools were available — items the regular role description would not capture.

For each item:
- "name": a short, action-led phrase (3–8 words). Use the participant's own role vocabulary where natural (e.g. "PR", "experiments", "advisor" for a CS PhD; "filings", "depositions" for a litigator). Do NOT pad with corporate buzzwords ("leverage", "synergize", "operationalize").
- "kind": "task" if it's a concrete recurring activity the participant performs (a unit of work). "responsibility" if it's a broader area of ongoing accountability the participant carries.

GROUNDING — read carefully:
- Start from the participant's actual AI usage answer. Translate vague phrasing ("I use it for everything") into SPECIFIC items inferred from their role + responsibilities. Do not echo the answer verbatim.
- Every item must be directly tied to their role. Don't import generic "use AI assistant" items. Use what their role does day-to-day as the anchor, and ask: what part of that work has been transformed or added because of AI?

GOOD examples (FOR SHAPE ONLY — do NOT copy):
  CS PhD with aiUsage "I use AI for code review and writing":
    { name: "Verify AI-generated code against tests",        kind: "task" }
    { name: "Spot-check AI summaries of papers",             kind: "task" }
    { name: "Curate prompt templates for the research group", kind: "responsibility" }
    { name: "Stay current on new model releases",            kind: "responsibility" }
  Litigator with aiUsage "for case research and drafting":
    { name: "Verify AI-summarized case citations",           kind: "task" }
    { name: "Redact PII before pasting into AI tools",       kind: "task" }
    { name: "Set firm policy on AI-drafted client work",     kind: "responsibility" }

CONSTRAINTS:
- 3–5 items total. Better to return fewer than to pad with generic items.
- Mix tasks and responsibilities only if both genuinely apply. If the role and AI usage suggest only tasks, return only tasks (and vice versa).
- Each item must read as something that did NOT exist (or existed differently) before this participant started using AI.

Return JSON: { "items": [{ "name": "...", "kind": "task" | "responsibility" }] }.`;

  const userBlock =
    `Job: ${jobTitle ?? '(unknown)'}\n` +
    (responsibilities ? `Primary responsibilities: ${responsibilities}\n` : '') +
    (typicalWeek ? `Typical week: ${typicalWeek}\n` : '') +
    `AI usage (the participant's own words): ${aiUsage}\n\n` +
    `Generate the AI-derived items.`;

  try {
    const response = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.6,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userBlock },
      ],
    });
    const parsed = JSON.parse(response.choices[0].message.content);
    const items = Array.isArray(parsed.items)
      ? parsed.items
          .filter(it => it && typeof it.name === 'string' && it.name.trim())
          .map(it => ({
            name: it.name.trim(),
            kind: it.kind === 'responsibility' ? 'responsibility' : 'task',
          }))
          .slice(0, 5)
      : [];
    console.log(`[generate-ai-tasks] role=${jobTitle} aiUsage="${aiUsage.slice(0, 60)}${aiUsage.length > 60 ? '…' : ''}" generated=${items.length}`);
    for (const it of items) console.log(`    ◦ [${it.kind}] ${it.name}`);
    res.json({ items });
  } catch (err) {
    console.error('[generate-ai-tasks]', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/propose-subtasks', async (req, res) => {
  const { taskLabel, coreTask, jobTitle, statementClarification, existingNodes = [], existingChildren = [], ancestorChain = [], responsibilities, typicalWeek, rejected = [], promptVariant = 'default' } = req.body;
  // existingChildren: direct children of the node being expanded. When non-empty,
  // we switch to "more" mode and ask for ADDITIONAL sub-tasks beyond what's there.
  // ancestorChain: labels from root → ... → parent of the node being expanded.
  // Empty array means we're decomposing the root itself (depth 0).

  const depth = ancestorChain.length;
  const granularityHint = depth === 0
    ? `You are decomposing the ROOT task of the tree. Sub-tasks here should be BROAD PHASES of the work — coarse buckets that hold finer steps inside them. Avoid micro-actions.`
    : depth <= 2
      ? `You are at depth ${depth} of the tree. Sub-tasks should be CONCRETE NAMED ACTIONS the person performs (e.g., "Read PR description", "Run test suite locally") — not phases, not single clicks.`
      : `You are at depth ${depth} of the tree — deep in the decomposition. Sub-tasks should be VERY SPECIFIC MICRO-ACTIONS (e.g., "Click the 'Files changed' tab", "Read the diff summary"). If the parent task is already concrete enough that further breakdown becomes trivial, return zero sub-tasks.`;

  const pathLine = depth > 0
    ? `\nPATH FROM ROOT: ${ancestorChain.map(l => `"${l}"`).join(' → ')} → "${taskLabel}" (the task you are decomposing)\n`
    : '';

  const isMore = existingChildren.length > 0;
  let ctx;
  if (isMore) {
    ctx = `The participant has already identified these sub-tasks under "${taskLabel}":
${existingChildren.map(c => `- "${c.label}"`).join('\n')}

Propose 1–3 ADDITIONAL sub-tasks that COMPLEMENT these — covering different angles or aspects that the existing list does not address. Do not refine, restate, or rephrase any existing sub-task. If you cannot think of genuinely distinct additional sub-tasks, return fewer (or even zero). It is much better to return nothing than to return something that overlaps with what is already there.${pathLine}`;
  } else if (statementClarification) {
    ctx = `Propose 3–4 sub-steps that make up "${taskLabel}" in the context of ${coreTask}. The participant described how they personally do this work: "${statementClarification}". Prefer phrasing and concrete actions that align with their description, but you may also propose well-grounded sub-steps that fit the task even if not explicitly named in the description — do not omit obvious ones just because they weren't mentioned word-for-word.${pathLine}`;
  } else {
    ctx = `Propose 3–4 sub-steps that make up "${taskLabel}" in the context of ${coreTask}.${pathLine}`;
  }
  ctx += `\n\nGRANULARITY: ${granularityHint}`;

  const existingList = existingNodes.length > 0
    ? `\n\nOTHER EXISTING NODES IN THE GRAPH (besides "${taskLabel}"):\n${existingNodes.map(n => `- id: ${n.id} | label: "${n.label}" | type: ${n.type}`).join('\n')}\n\nIMPORTANT: If a sub-step you'd propose is essentially the same as one of these existing nodes, DO NOT create it as a new sub-step. Instead, mark it as a connection to that existing node by setting "linkToExistingId" to the existing node's id. The system will draw an edge from the parent to that existing node instead of creating a duplicate.`
    : '';

  // Rejection signal: sub-tasks the participant previously discarded for this
  // same parent. Teaches the model not to re-propose what they've already said
  // no to — strongest available preference signal we have for this participant.
  const rejectedList = Array.isArray(rejected) && rejected.length > 0
    ? `\n\nSUB-TASKS THE PARTICIPANT PREVIOUSLY DISCARDED for "${taskLabel}":\n${rejected.map(r => `- "${r}"`).join('\n')}\n\nDO NOT re-propose any of these or close paraphrases of them. The participant has explicitly said these don't apply to their work. Treat semantic overlap with this list the same way you'd treat overlap with the existing nodes list.`
    : '';
  const isWorkerVariant = promptVariant === 'worker';

  try {
    const response = await client.chat.completions.create({
      // Subtask decomposition is the participant's main interaction on the
      // canvas — quality matters more than per-call cost. Use the stronger
      // MODEL (gpt-5 family) rather than SMALL_MODEL.
      model: MODEL,
      response_format: { type: 'json_object' },
      messages: isWorkerVariant ? [
        {
          role: 'system',
          content: SUBTASK_WORKER_SYSTEM_PROMPT,
        },
        {
          role: 'user',
          content:
            `Role: ${jobTitle}` +
            (responsibilities ? `\nWhat this person is responsible for: ${responsibilities}` : '') +
            (typicalWeek ? `\nHow they described a typical week: ${typicalWeek}` : '') +
            `\nMain task they're mapping: ${coreTask}` +
            (depth > 0 ? `\nCurrent path: ${ancestorChain.join(' → ')} → ${taskLabel}` : `\nTask to break down: ${taskLabel}`) +
            (statementClarification ? `\nHow they described doing it: "${statementClarification}"` : '') +
            `\n\nYou are this worker. What steps do you take to do "${taskLabel}"?` +
            existingList + rejectedList,
        },
      ] : [
        {
          role: 'system',
          content: `You decompose a task into its constituent sub-tasks. Return JSON: { "subtasks": [{ "label": "string (4-8 words, sentence case)", "linkToExistingId": "string (optional)" }] }.

LABEL FORMAT: Sentence case (capitalize only the first word), 4–8 words. Be specific — include the object and a short context phrase when useful (e.g. "Pull latest branch from remote", "Flag ambiguous requirements in ticket", "Run test suite against staging"). Plain verb + object language a coworker would immediately recognize. Avoid one-word or two-word stubs.

INTERPRET THE PARENT IN CONTEXT (read this FIRST — it changes how to handle vague labels):
- The user message gives you the PATH FROM ROOT (ancestor chain), the main workflow, the participant's role, and often the participant's walkthrough. Use ALL of this to understand what the parent label actually means before drafting sub-tasks.
- If the parent label is short (1-3 words) or generic on its own ("Use Claude", "Review", "Setup", "Send", "Check"), DO NOT refuse — instead, interpret it as shorthand for its contextualized meaning, then decompose THAT.
  Example: parent "Use Claude" with ancestor "Use Claude for debugging" in workflow "Debug code" — decompose as if the participant wrote "Use Claude for debugging". Produce concrete steps like "Describe the bug to Claude", "Share relevant code or logs", "Apply Claude's suggested fix", "Verify the fix works".
  Example: parent "Review" with ancestor "Review pull request" — treat as "Review pull request". Produce "Read the diff", "Check tests pass", "Leave inline comments", "Approve or request changes".
  Example: parent "Setup" with ancestor "Set up dev environment" — treat as "Set up dev environment". Produce concrete setup actions, not generic "Get started" / "Begin setup".
- This is INTERPRETATION ONLY — output sub-tasks for the contextualized meaning, but do not rename the parent and do not echo the ancestor's label.
- Still apply ALL the dedup/anti-overlap rules below. If the contextualized parent already has its children represented elsewhere in the graph, use linkToExistingId or omit. Only return empty if even WITH the full context you cannot identify two genuinely distinct parts.

FIRST-PERSON ACTIONS ONLY (critical — common failure mode for participants who build software, content, or other artifacts):
- Sub-tasks must describe what the PARTICIPANT does — what they type, click, say, decide, read, write, sketch, review, or send. Their hands, their attention, their judgment.
- If the participant's walkthrough includes the behavior of a product they build (an end-user flow, an app screen sequence, a system state transition, what happens "when the user clicks X"), IGNORE that material — it describes the artifact, not the work of making it.
- Gut check for every sub-task you draft: does this describe something the participant performs at their keyboard / on a call / at a whiteboard, or something the SYSTEM does for an end user? Only the former qualifies as a sub-task.
- BAD example — participant who builds an app describes its end-user flow ("user opens app, sees login screen, enters credentials, lands on dashboard, can filter and export reports"):
  ✗ "User logs in", "User views dashboard", "User filters reports", "User exports a report" — these describe what the APP does, not what the participant does to build it.
  ✓ "Sketch screen-by-screen wireframes", "Map states and transitions", "Identify edge cases and error states", "Review the flow with stakeholders" — these describe the participant's actual planning work.
- This rule applies to ANY artifact the participant builds: software (user flows), content (reading experience of an article), curriculum (learner journey), products (end-user steps). Always reframe to the participant's own activities.

This is a DECOMPOSITION tree, not a process flow. Do not invent sequence, branching, or terminal markers:
- NEVER produce nodes labeled "Start", "Begin", "End", "Done", "Finish", "Review", or any other process boundary marker.
- NEVER imply ordering between sibling sub-tasks. They are an unordered set of things the parent task is composed of.
- Do not phrase any sub-task as a yes/no question — there are no branches.

CRITICAL DEDUP RULES:
- Look at the OTHER EXISTING NODES list. For each potential sub-task, check whether it OVERLAPS in MEANING with any existing node — not just exact labels. E.g. "Evaluate code quality" overlaps with an existing "Examine code style" or "Review code" node, even though the words differ.
- If a sub-task overlaps with an existing node: OMIT it entirely. Don't create a duplicate, don't even link to it.
- NEVER propose a sub-task that conceptually belongs under a DIFFERENT existing parent.
- NEVER propose a sub-task that is a paraphrase, synonym, rewording, or TRUNCATION of the PARENT task being expanded. A sub-task must describe a SMALLER PART of the parent, not the parent in different words and not the parent with a qualifier dropped.
  BAD: parent "Answer emails" → "Respond to emails" (synonym, not a part).
  BAD: parent "Review code" → "Conduct code review" (paraphrase).
  BAD: parent "Run experiments" → "Execute experiments" (synonym).
  BAD: parent "Use Claude for debugging" → "Use Claude" (TRUNCATION — drops the qualifier "for debugging" and gives back the parent).
  BAD: parent "Review residential blueprints" → "Review blueprints" (truncation).
  RULE: if your sub-task is the parent with a word removed, it IS the parent, not a part of it. Reject it.
  GOOD: parent "Answer emails" → "Draft reply", "Triage by sender", "Send and archive" (distinct parts of answering).
  GOOD: parent "Use Claude for debugging" → "Describe the bug to Claude", "Share relevant code or logs", "Apply Claude's suggested fix", "Verify the fix works" (distinct parts of the debugging workflow with Claude).
- If you cannot identify at least two genuinely distinct PARTS of the parent task, return an empty subtasks array rather than rephrasing the parent.

MUTUAL EXCLUSIVITY (just as critical):
- The sub-tasks you propose must be MUTUALLY EXCLUSIVE — each one covers a distinct concern, not a different angle of the same concern.
- BAD examples (too similar to each other): "Check code functionality" + "Examine tests" + "Assess code readability" — these all touch on aspects of "review the code" and overlap.
- GOOD examples for "Review code" (distinct concerns): "Read PR description", "Run code locally", "Add inline comments", "Mark review status". Each is a different concrete action.
- Test: if you can read two of your sub-tasks and a person could plausibly be doing both at the same moment, they overlap — replace one.

SIBLING-PAIR SYNONYM CHECK (before you return):
- After drafting your sub-tasks, walk every pair. If two share the same VERB + OBJECT meaning — even when the wording differs — DROP ONE. Same meaning includes:
  (a) one paraphrases the other,
  (b) one is the other with the parent's qualifier appended ("with Claude", "for the PR", etc.),
  (c) one is a shorter form of the other with the same head verb and object.
- BAD pair: "Discuss findings" + "Discuss findings with Claude" — same verb+object, second just appends the parent's context. Drop one.
- BAD pair: "Ask clarifying questions" + "Ask questions in Claude" — same verb+object, paraphrased qualifier. Drop one.
- BAD pair: "Run tests" + "Execute test suite" — synonyms. Drop one.
- BAD pair: "Write the PRD" + "Draft product requirements" — same artifact, paraphrased verb. Drop one.
- If dropping leaves you with 1 or 0 sub-tasks, return that — never refill the slot with another paraphrase.

VERB DIVERSITY ACROSS SIBLINGS:
- Each sub-task should NAME A DIFFERENT KIND OF ACTION, not the same action against different objects. If 3+ siblings share the same head verb (all "Review …", all "Verify …", all "Check …"), the set is flat and probably collapsing several real activities into rewordings of one.
- After drafting, look at the verbs. If you have ≥3 sub-tasks that begin with the same verb stem, REPLACE at least one with a verb that names a genuinely different activity (read vs. run vs. comment, sketch vs. write vs. review, send vs. file vs. call).
- BAD: parent "Review pull request" → ["Review the diff", "Review test coverage", "Review code style", "Review CI status"]. Four "Review X" rewordings.
- GOOD: parent "Review pull request" → ["Read the diff", "Run tests locally", "Comment on issues", "Approve or request changes"]. Each verb names a different physical action.
- AVOID using the parent's head verb in your sub-tasks unless the sub-task truly is a smaller instance of that verb. "Review code" → child "Review style" is the parent in different clothes; "Run linters" is a different action that supports the parent.

PARAPHRASE-OF-PARENT CHECK (the whole sibling set restates the parent):
- The synonym check above catches pairs. This one catches the case where the ENTIRE set of siblings is the same activity as the parent, reworded into 2–4 different verb/object surfaces. This happens most often when the parent is an activity verb like "Understand X", "Adjust Y", "Discuss Z", "Evaluate Z" — the model varies the surface form instead of finding constituent sub-actions.
- BAD: parent "Understand business impact and urgency" → "Identify high-impact tasks" + "Compare task importance" + "Evaluate deadline risks". All three are "the activity of figuring out what's most important" — three reframings, not three sub-actions.
- BAD: parent "Adjust priorities when urgent demands appear" → "Reorganize workload during the day" + "Respond to unexpected requests" + "Handle urgent issues quickly". All three restate the parent itself.
- BAD: parent "Discuss priorities with supervisor and team" → "Confirm which task to prioritize" + "Align priorities with company goals" + "Discuss deadline expectations". All three are the same conversation viewed slightly differently.
- WHOLE-SET TEST: if a participant performed any ONE of your siblings, could they still honestly say they had NOT done the parent? If doing any single sibling alone is essentially the parent done, the set is restating, not decomposing. Reject it.
- GOOD: parent "Discuss priorities with supervisor and team" → "Schedule the sync" + "Bring task list to the meeting" + "Capture decisions in writing" + "Share updates with the team afterward". Each is a distinct STEP — doing one alone does NOT complete the parent.
- GOOD: parent "Understand business impact and urgency" → "Skim incoming requests" + "Ask the requester for context" + "Estimate scope and deadline" + "Flag dependencies on other work". Each is a different concrete sub-action you'd actually perform.
- WHEN THE PARENT IS ATOMIC: if the parent is already a single activity that's done all-at-once (no internal phases), DO NOT manufacture siblings. Return fewer sub-tasks (or zero) rather than three rewordings. Atomic activity parents are common at depth ≥ 2.

GRANULARITY (read the per-request GRANULARITY hint below — it governs how specific your labels should be):
- At the TOP of the tree (root decomposition): sub-tasks are broad phases like "Read the change", "Decide approval". Don't try to be hyper-specific here — broad phrasing is correct.
- At MID depths: sub-tasks describe concrete named actions like "Run the test suite locally", "Open the file in editor". Still phrase-level, but a person can see exactly what action it points to.
- At DEEP levels: sub-tasks are observable micro-actions like "Click the 'Files changed' tab", "Scroll to the first hunk". Anyone could watch you do them.
- AVOID vague filler phrases regardless of depth: "potential impacts", "key considerations", "relevant factors", "appropriate criteria", "the situation".

Generate AT MOST 4 sub-tasks. Fewer is better than more — only propose ones you're confident apply. If you can't think of 4 distinct, mutually-exclusive, concrete sub-tasks, propose 2 or 3.`,
        },
        {
          role: 'user',
          content:
            `Role: ${jobTitle}` +
            (responsibilities ? `\nPrimary responsibilities (their words): ${responsibilities}` : '') +
            (typicalWeek ? `\nTypical week: ${typicalWeek}` : '') +
            `\nMain workflow: ${coreTask}\n\n${ctx}${existingList}${rejectedList}`,
        },
      ],
    });
    const parsed = JSON.parse(response.choices[0].message.content);
    const existingIds = new Set(existingNodes.map(n => n.id));

    // Build a fuzzy-match index of existing nodes by normalized label
    const normalize = (s) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const labelToId = new Map();
    for (const n of existingNodes) {
      labelToId.set(normalize(n.label), n.id);
    }

    // In "more" mode the direct children of the node being expanded are passed
    // separately. They are also "existing" — anything matching one of them
    // should be DROPPED outright (not linked, since linking would make a node
    // its own sibling). Build a set of their normalized labels for filtering.
    const childLabels = new Set(existingChildren.map(c => normalize(c.label)));

    // The current task being expanded — never propose it as a subtask of itself
    const currentNorm = normalize(taskLabel);

    // Filter out any process-boundary markers the AI may still slip in.
    const BOUNDARY = new Set(['start', 'begin', 'end', 'done', 'finish', 'finished', 'complete', 'completed', 'review']);

    const seenNormalized = new Set();
    const subtasks = (parsed.subtasks ?? [])
      .map(s => {
        const norm = normalize(s.label);
        // Server-side fallback: if AI proposed a label matching an existing node, set linkToExistingId
        let link = existingIds.has(s.linkToExistingId) ? s.linkToExistingId : undefined;
        if (!link && labelToId.has(norm)) link = labelToId.get(norm);
        return {
          label: s.label ?? '',
          linkToExistingId: link,
          _norm: norm,
        };
      })
      // Drop duplicates, self-references, process-boundary markers, and any
      // proposal that matches a direct child of the node being expanded
      // (catches the model re-proposing what's already there in "more" mode).
      .filter(s => {
        if (!s.label) return false;
        if (s._norm === currentNorm) return false; // proposing the parent itself as a sub-step
        if (BOUNDARY.has(s._norm)) return false;
        if (childLabels.has(s._norm)) return false; // overlaps an existing direct child
        if (seenNormalized.has(s._norm)) return false;
        seenNormalized.add(s._norm);
        return true;
      })
      .map(({ _norm, ...rest }) => rest)
      .slice(0, 4); // hard cap so the canvas never gets flooded
    res.json({ subtasks });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/propose-relationships', async (req, res) => {
  const { nodes, coreTask, jobTitle } = req.body;
  // Returns proposed edges with confidence
  try {
    const nodeListStr = nodes.map(n => `- ${n.id}: ${n.label}${n.parentId ? ` (sub-step of ${n.parentId})` : ''}`).join('\n');
    const response = await client.chat.completions.create({
      model: SMALL_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are mapping the directed flow between tasks in a workflow. Given a list of nodes, propose edges showing the order of execution and any branches.

Return JSON: { "edges": [{ "source": "node_id", "target": "node_id", "label": "optional edge label like 'if approved' or 'on failure'", "is_branch": boolean, "confidence": "high" | "medium" | "low" }] }

Rules:
- Only propose edges between nodes from the provided list
- 'high' confidence: clear sequential or causal relationship
- 'medium': plausible but could go differently
- 'low': uncertain — needs participant confirmation
- Sub-steps within a parent should chain together
- The last sub-step of one parent task connects to the first sub-step of the next parent task
- Use is_branch=true for paths that don't rejoin the main flow`,
        },
        { role: 'user', content: `Role: ${jobTitle}\nWorkflow: ${coreTask}\n\nNodes:\n${nodeListStr}\n\nPropose the directed edges between these nodes.` },
      ],
    });
    const parsed = JSON.parse(response.choices[0].message.content);
    res.json({ edges: parsed.edges ?? [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/gap-analysis', async (req, res) => {
  const { nodes, edges, coreTask, jobTitle, participantOverview } = req.body;
  const nodeListStr = nodes.map(n => `  - ${n.id} [${n.type}]${n.actor ? ` (${n.actor})` : ''} "${n.label}"${n.description ? ` — ${n.description}` : ''}`).join('\n');
  const edgeListStr = edges.length === 0
    ? '  (none)'
    : edges.map(e => `  - ${e.source} → ${e.target}${e.label ? ` (${e.label})` : ''}`).join('\n');
  const overviewBlock = participantOverview
    ? `\n\nPARTICIPANT'S ORIGINAL OVERVIEW (verbatim):\n"""${participantOverview}"""\n\nUse this to (a) avoid suggesting things they already mentioned, (b) borrow their vocabulary, (c) spot what's specifically missing rather than what's generically missing.`
    : '';

  try {
    const response = await client.chat.completions.create({
      model: SMALL_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are reviewing a workflow graph extracted from a participant's first-pass description. First-pass descriptions almost always miss things — implicit context, intermediate steps, common decision branches, big-verb tasks that hide sub-actions. Your job is to surface 1–3 of these so the participant can confirm or correct.

Calibration: for a typical 4-9 node first-pass, you should usually find 1–3 gaps. 0 gaps is unusual and only correct when the workflow is unusually detailed. >3 dilutes the signal.

The four gates below filter out clearly bad candidates. Use them to prune slop, NOT to demand perfection. Directionally useful is good enough — the participant can dismiss anything they disagree with. If you find yourself dropping every candidate, your standards are too strict.

GATE 1 — DEDUP. Scan every existing node's label AND description. Does any node already cover this candidate's meaning, even with different wording? If yes, drop. Stretching to argue non-equivalence is a sign you should drop.

GATE 2 — OVERVIEW EVIDENCE. Quote the phrase from the participant's overview that motivates this candidate (either supporting it as a real omission, or showing they already mentioned it). If you can't tie the candidate to a specific phrase or a specific silence, drop.

GATE 3 — CONCRETENESS. The candidate must name a specific artifact, tool, or output (a doc, a ticket, a tool's UI, a message channel, a meeting). Generic verbs like "gather context", "set up", "plan", "summarize", "discuss", "align", "prepare", "review the work" don't qualify.

GATE 4 — CONFIDENCE. Would most people in this role at this step do this exact thing? If you're guessing, drop.

────────────────────────────────────────
LENS 1 — MISSING TASKS
A concrete step the participant didn't mention but that almost everyone in this role does AT THIS POINT in the workflow. Insert BETWEEN two existing participant-stated steps.

SCOPE RULES (skip immediately if violated):
- The anchor (target of the new edge) MUST be a real participant-stated task/decision/handoff/wait.
- The PREDECESSOR of the new task (where the new edge originates) MUST also be a participant-stated process node — NEVER the 'start' node. Tasks that come "before the start" or "right after the start" are out of scope: 'start' represents how work arrives, not a step the participant performs. If your only candidate insertion is between 'start' and the first task, drop it.
- Similarly never insert between the last task and the 'end' node — that's also out of scope.
- The 'start' and 'end' nodes are sentinels, not workflow steps. Don't propose anything that touches them.

QUALITY BAR:
- Verb + specific object/artifact. The label has to say WHAT specifically gets read/written/sent/clicked/opened.
- Tied to a real artifact in this role (a doc, a ticket, a dashboard, a meeting, a tool's UI).
- Not a meta-step ("Plan", "Prepare", "Set up", "Gather context", "Pull logs", "Discuss", "Align" — almost always too abstract).

Skip if any of the principles above (semantic dedup, overview-aware) shows it's already covered.

────────────────────────────────────────
LENS 2 — DECOMPOSABLE TASKS
Propose decompose AT MOST ONCE per response.

NEVER decompose a node whose type is 'decision'. NEVER decompose a node whose label reads as a decision (contains "decide", "choose", "approve or", ends with "?", names a binary outcome). Decisions branch — they don't have sub-steps. This rule has no exceptions.

VERB-CATEGORY TEST: strip the label down to its verb. If the verb alone names a CATEGORY of work (multiple distinct actions could fit under it — review, manage, plan, evaluate, coordinate, triage, handle, prepare-as-a-process), the label may qualify. If the verb alone names a SINGLE atomic action (read, write, send, open, run, pull, click, submit, leave, post, comment, attach), the label is atomic — DO NOT decompose.

ENUMERATION TEST: if the label or description already lists multiple things (contains " and ", " / ", "," joining actions, or names ≥2 specific objects), the breakdown is already shown — SKIP.

SUB-STEP "PART" TEST: for each candidate sub-step ask: "If the participant skips this step, is the parent task incomplete?" If NO for any candidate, abandon the decompose — your candidates are leaking into prerequisites or follow-ups (those belong elsewhere in the flow, not as children).

MUTUAL-EXCLUSIVITY TEST: each sub-step must be a different ACTION, not a different aspect or stage of the same action. If two sub-steps describe the same action at different polish levels (draft → format → finalize, identify → write — writing IS identifying), abandon.

DEFAULT: when in doubt, return 0 decompose gaps. A confident decompose has 3+ clearly distinct parts that all must happen for the parent to be complete.

────────────────────────────────────────
LENS 3 — DEPENDENCIES & BRANCHES
A missing edge between TWO EXISTING nodes — never invent a new node here.

ARTIFACT-FLOW TEST: name the concrete thing that flows on this edge (the doc, the data, the decision, the message). If you can't name it, the edge isn't a real dependency, just a sequence — SKIP.

NON-REDUNDANCY TEST: the artifact's flow must not already be implied by the existing sequential path. If A → B is already in the graph, don't re-propose it. If A → C → B exists and the artifact passes through C anyway, don't propose A → B.

DECISION-BRANCH CHECK: for any 'decision' node, verify it has outgoing edges for every plausible answer to its question. If a branch is conceptually required but missing (e.g. one outcome loops back, isn't drawn), propose that edge.

────────────────────────────────────────
QUICK SELF-CHECK before returning:
Re-read each gap. Drop only obvious offenders:
- Generic placeholder verbs ("gather context", "summarize", "prepare", "set up") that aren't tied to a real artifact in this role.
- Exact duplicates of existing nodes.
Keep everything else, even if minor — the participant has a Dismiss button.

────────────────────────────────────────
GAP SHAPE — return:
{
  "id": "snake_case_gap_id",
  "lens": "missing" | "decompose" | "dependency",
  "anchor_node_id": "<id of an existing node>",
  "title": "Short headline (≤10 words). ALWAYS use the human-readable node LABELS in quotes — NEVER snake_case ids. Mirror these patterns: 'Add \\"<new label>\\" before \\"<existing label>\\"' / 'Break down \\"<existing label>\\"' / 'Connect \\"<source label>\\" → \\"<target label>\\" (<artifact>)'",
  "rationale": "ONE concise reason, max 14 words. Plain language, no flourish, no restating the title. E.g. 'Reviewers usually read the description first to understand intent.' Not 'It is crucial to understand the context before diving into the code.'",
  "proposed_changes": [ ...graph edits, see below ]
}

anchor_node_id rule:
  - missing: the existing node the new task is inserted BEFORE
  - decompose: the parent task being broken down
  - dependency: the target node of the new edge

PROPOSED CHANGES — each is one of:
- { "tool": "add_node", "input": { "id": "snake_case", "type": "task|decision|handoff|wait|failure", "label": "Concrete action (2–5 words)", "description": "Short subtitle, max 6 words", "parentId": "<id> ONLY for decompose sub-steps" } }
- { "tool": "add_edge", "input": { "source": "<id>", "target": "<id>", "label": "<artifact/condition>" } }
- { "tool": "remove_edge", "input": { "source": "<id>", "target": "<id>" } }

WIRING:
- MISSING: emit add_node, then add_edge new_node → anchor, AND for every predecessor X of anchor: add_edge X → new_node + remove_edge X → anchor.
- DECOMPOSE: emit only add_node calls with parentId set. Client wires sub-step chain automatically.
- DEPENDENCY: emit a single add_edge with a meaningful label.

Return JSON: { "gaps": [...] }. Order: missing → decompose → dependency. Remember: returning 0 gaps is a valid, often correct answer.${overviewBlock}`,
        },
        { role: 'user', content: `Role: ${jobTitle}\nWorkflow: ${coreTask}\n\nNODES:\n${nodeListStr}\n\nEDGES:\n${edgeListStr}\n\nFind the gaps worth asking about and propose the graph edits.` },
      ],
    });
    const parsed = JSON.parse(response.choices[0].message.content);
    res.json({ gaps: parsed.gaps ?? [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/walker-interview', async (req, res) => {
  const { nodes, edges, coreTask, jobTitle, participantOverview } = req.body;
  const nodeListStr = nodes.map(n => `  - ${n.id} [${n.type}] "${n.label}"${n.description ? ` — ${n.description}` : ''}`).join('\n');
  const edgeListStr = edges.length === 0
    ? '  (none)'
    : edges.map(e => `  - ${e.source} → ${e.target}${e.label ? ` (${e.label})` : ''}`).join('\n');
  const overviewBlock = participantOverview
    ? `\n\nPARTICIPANT'S ORIGINAL OVERVIEW (verbatim):\n"""${participantOverview}"""`
    : '';

  try {
    const response = await client.chat.completions.create({
      model: SMALL_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are designing a guided interview that walks a participant through their workflow, step by step, in execution order. The interface will play your steps one at a time as cards anchored to nodes in the graph.

Generate an ordered list of "interview steps". There are THREE step kinds:

1. "transition" — confirm the participant moves from one task to the next. Yes/No question. Also captures the data/artifact that flows on the edge when relevant (a dependency).
   - For the FIRST transition (from the 'start' node to the first task): phrase as "Once <trigger>, do you start by <first task>?". Use the start node's label as the trigger ("Once a PR is opened, do you start by reviewing code?").
   - For subsequent transitions (between two tasks): "After you <prev task>, do you <next task>?".
   - When there's an obvious artifact/data flowing from prev to next (e.g. test results, the design doc, the customer reply, a list of issues), set "edge_label" to that artifact name (1–3 words). On confirmation we'll label the edge with it. Skip "edge_label" when the transition is just sequential with no specific artifact in the role's vocabulary.
   - Use natural participant-friendly language. NEVER use snake_case ids in question text — use the human label.

2. "missing" — an intermediate task that almost everyone in this role does at this point but isn't represented in the graph. Yes/No question with a proposed task.
   - Phrase as "Before you <next task>, do you also <proposed task>?" or "Between <prev> and <next>, do you <proposed task>?".
   - Insert this step BETWEEN the prev/anchor transition pair (so it's asked right when the relevant transition would otherwise be confirmed).
   - PROPOSE one whenever you can think of a step that (a) is concrete (verb + specific artifact: a doc, ticket, tool, message, output) AND (b) most people in this role would do at this point AND (c) isn't already implied by the participant's overview or covered by an existing node.
   - DO NOT propose meta-steps ("Plan", "Set up", "Gather context", "Discuss", "Align") — must reference a specific artifact.
   - DO NOT insert before the FIRST task of the workflow (the predecessor would be the 'start' sentinel — out of scope).
   - Include a "proposed_task" field with { id, label, description, type } for the new task.
   - Aim for 0–2 "missing" steps for a typical workflow. Lean toward proposing when the participant's overview is brief — they almost certainly skipped steps.

3. "decompose" — when a task's label is a "big verb" category that hides specific sub-steps, ask what those sub-steps are with 2–4 suggested sub-steps.
   - Phrase as "When you <task>, what specifically do you do?".
   - Suggestions: specific verb + object, mutually exclusive, role-grounded. 2–4 of them.
   - INSERT a decompose step immediately AFTER the transition step that arrived at this task.

PROPOSE decompose for ANY task whose label leads with a categorical verb that names a category of work (review, manage, plan, evaluate, coordinate, triage, handle, screen, debrief, prepare, design, audit, assess, investigate). These verbs almost always hide multiple distinct sub-actions. Skip ONLY if:
- The node is type='decision'.
- The verb is atomic (read, write, send, open, run, pull, click, leave, comment, submit, add, post).
- The label or description already enumerates ≥2 specific objects/actions (contains " and ", " / ", a comma list).

ORDER (strict):
- Walk transitions in execution order (start → first task → second task → ... → last task → end).
- Skip transitions that touch the 'end' sentinel — once you've covered all tasks, stop.
- A "missing" step (if any) goes IMMEDIATELY BEFORE the transition step it would precede.
- A "decompose" step (if any) goes IMMEDIATELY AFTER its task's transition step.

Step shape:
{
  "kind": "transition" | "missing" | "decompose",
  "anchor_node_id": "<id of the node this step focuses on>",
  "prev_node_id": "<id of the previous task>" (transition + missing steps),
  "question": "<natural-language question to ask the participant>",
  "edge_label": "<artifact/data flowing on this edge>" (transition steps only; optional),
  "suggestions": [{ "label": "...", "description": "...", "type": "task" }] (decompose steps),
  "proposed_task": { "id": "snake_case_id", "label": "...", "description": "...", "type": "task" } (missing steps)
}

For TRANSITION steps, anchor_node_id is the NEXT task (the target of the existing transition).
For MISSING steps, anchor_node_id is the next task the proposed task would be inserted BEFORE.
For DECOMPOSE steps, anchor_node_id is the task being decomposed.

Return JSON: { "steps": [...] }.${overviewBlock}`,
        },
        { role: 'user', content: `Role: ${jobTitle}\nWorkflow: ${coreTask}\n\nNODES:\n${nodeListStr}\n\nEDGES:\n${edgeListStr}\n\nGenerate the interview steps in workflow order.` },
      ],
    });
    const parsed = JSON.parse(response.choices[0].message.content);
    res.json({ steps: parsed.steps ?? [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/expand-node', async (req, res) => {
  const { jobTitle, nodeLabel, level, ancestors = [] } = req.body;
  const childLevel = level === 'role' ? 'task' : 'subtask';
  const context = ancestors.length ? `Context: ${ancestors.join(' → ')} → ${nodeLabel}` : '';

  const systemPrompt = level === 'role'
    ? `You are mapping every task a ${jobTitle} actually does. Generate 10–15 diverse, concrete tasks covering the full breadth of this role — routine, collaborative, analytical, and output tasks. Each must be a real action this person does (verb + object, e.g. "Write sprint tickets", "Review pull requests"). Spread coverage across all areas of the role. Return JSON: { "children": [{ "label": "string (2–5 words)", "hasChildren": true }] }. hasChildren is always true for tasks.`
    : `You are expanding a specific task into its sub-steps. Generate 4–6 concrete sequential sub-steps for the given task. Each is a specific action within that task. Return JSON: { "children": [{ "label": "string (2–5 words)", "hasChildren": false }] }. hasChildren is false for sub-steps.`;

  try {
    const response = await client.chat.completions.create({
      model: SMALL_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `${context}\nExpand: "${nodeLabel}"` },
      ],
    });
    const parsed = JSON.parse(response.choices[0].message.content);
    const ts = Date.now();
    const children = (parsed.children ?? []).map((c, i) => ({
      id: `${nodeLabel.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${i}_${ts}`,
      label: c.label,
      level: childLevel,
      hasChildren: c.hasChildren !== false,
    }));
    res.json({ children, childLevel });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Generate a natural conversational kickoff question + a short display label.
// One round trip so WorkflowKickoff can both ask a fluent question and pass a
// concise title (≤5 words) to the mapping phase for canvas / top-bar use.
app.post('/api/kickoff-question', async (req, res) => {
  const { taskLabel } = req.body;
  if (!taskLabel || typeof taskLabel !== 'string') {
    return res.status(400).json({ error: 'taskLabel required' });
  }
  try {
    const response = await client.chat.completions.create({
      // Walkthrough kickoff question needs to feel conversational and faithful
      // to the participant's wording — use the stronger MODEL (gpt-5 family)
      // rather than SMALL_MODEL.
      model: MODEL,
      temperature: 0.9,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You produce two things from a participant\'s task description:\n' +
            '1. "question": a short, natural conversational question (≤22 words, ends with "?") that gets them describing the MULTIPLE CONCRETE ACTIONS this task involves. The answer will be decomposed into subtasks, so the question must pull for several distinct steps / components / sub-activities — never a single-fact or opinion answer. Phrase in second person; strip first-person pronouns ("I", "my").\n' +
            '2. "shortLabel": a concise canvas title (2–5 words, Title Case, no trailing period) that stays faithful to the participant\'s own wording.\n\n' +
            'Rules for the question — vary the opener so it doesn\'t feel formulaic, but every framing must elicit MULTIPLE concrete actions. Match the framing to the task\'s SHAPE:\n' +
            '- Sequential procedure (start-to-finish): "Walk me through how you ... from start to finish?", "What are the main steps when you ...?"\n' +
            '- Recurring routine (regular, no clear endpoint): "What does a typical week of ... involve — what are the main things you do?", "When you sit down to ..., what are the different things that go into it?"\n' +
            '- Judgment / decision-heavy: "Walk me through your process for deciding ...?", "When you ..., what are all the things you actually do before landing on a call?" (NOT just "How do you decide ...?" — that yields a one-line answer)\n' +
            '- Open-ended project (something the participant builds, produces, or ships): "When you ..., what does YOUR work look like — the activities, not the end product?", "What are the main things you do while ... — the tasks themselves, not what gets built?". Pull for the participant\'s actions, NOT a narrative of how the thing they built behaves. Avoid "think about the last time" framings — those invite story-telling and end-user-flow descriptions of the artifact.\n' +
            '- Passive / loose tasks (attending, staying current, etc.): pivot to the active work AROUND it — "What do you do before, during, and after ...?", "What are all the things you do to get value out of ...?"\n' +
            'Hard rule: NEVER ask a question whose natural answer is a single sentence or a yes/no. The question must invite the participant to enumerate multiple actions. If you find yourself writing "How do you decide X?" or "What do you do to X?" with no expansion, add "— what are the main things involved?" or "walk me through what that looks like" to force a multi-step answer.\n' +
            'Diversify your openers. Do NOT lean on the same template for every task in a category — vary phrasing, sentence structure, and which prompt-words you use to elicit enumeration ("the steps", "the main things", "what goes into it", "from X to Y", "what does that look like", "agenda / what comes up / what you walk away with", etc.). Imagine you are asking ten participants ten different versions of this prompt — pick a fresh angle each time.\n' +
            'Do NOT mechanically default to "Can you walk me through ...?" or "What do you do before, during, and after ...?" — those are useful framings but NOT the only ones. The literal phrase "before, during, and after" is OVERUSED — use it at most rarely, and prefer paraphrases ("prep, the session, and afterward", "the lead-up, the meeting itself, and the follow-up", "going in, what happens, and what you do with it after") or entirely different framings ("What does a typical advisor meeting look like — agenda, what comes up, what you walk away with?", "When you sit down with X, what\'s usually on the docket?").\n\n' +
            'Rules for shortLabel:\n' +
            '- Build it from verbs and nouns the participant actually used. Don\'t swap in a generic workplace category (e.g. "Daily Standup", "Email Triage", "Inbox Management") that they didn\'t say.\n' +
            '- Don\'t add framing words ("Daily", "Weekly", "Manage", "Triage") unless the input contains them.\n' +
            '- If the input is already short, prefer Title-Casing it over rewriting.\n\n' +
            'Examples:\n' +
            'Input "Implement ticket changes" → { "question": "Walk me through how you implement a ticket from picking it up to merging.", "shortLabel": "Implement Ticket Changes" }\n' +
            'Input "Review pull requests from my teammates and leave comments before approving" → { "question": "When a teammate\'s PR lands in your queue, what are all the things you do before approving?", "shortLabel": "Review Pull Requests" }\n' +
            'Input "Decide which experiments to run next" → { "question": "Walk me through your process for deciding which experiments to run next — what are the steps?", "shortLabel": "Decide Next Experiments" }\n' +
            'Input "Attend classes and seminars" → { "question": "When you sit through a seminar, what does the work around it look like — prep, the session, and afterward?", "shortLabel": "Attend Classes And Seminars" }\n' +
            'Input "Stay current with new ML papers" → { "question": "What are all the things you do to stay current with new ML papers — where do you look, what do you read, how do you keep track?", "shortLabel": "Stay Current On ML Papers" }\n' +
            'Input "Mentor junior researchers" → { "question": "What does mentoring a junior researcher involve for you week to week — what are the main things you do?", "shortLabel": "Mentor Junior Researchers" }\n\n' +
            'Return JSON: { "question": "string", "shortLabel": "string" }.',
        },
        { role: 'user', content: `Task description:\n${taskLabel}` },
      ],
    });
    const parsed = JSON.parse(response.choices[0].message.content);
    const q = (parsed.question ?? '').trim();
    const shortLabel = (parsed.shortLabel ?? '').trim();
    if (!q) return res.status(500).json({ error: 'empty question' });
    res.json({ question: q, shortLabel: shortLabel || taskLabel });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/suggest-actors', async (req, res) => {
  const { transcript, jobTitle } = req.body;
  try {
    const response = await client.chat.completions.create({
      model: SMALL_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'Extract all people, teams, and systems mentioned as doing work in this workflow transcript. Return JSON: { "actors": ["string"] }. Include the participant themselves as the first actor (use "Me" or their role). Include colleagues, managers, external systems, bots, AI tools. Be specific (e.g. "Tech Lead" not "person"). 4–8 actors max.',
        },
        { role: 'user', content: `Role: ${jobTitle}\nTranscript:\n${transcript}` },
      ],
    });
    const parsed = JSON.parse(response.choices[0].message.content);
    res.json({ actors: parsed.actors ?? ['Me'] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/handoff-chat', async (req, res) => {
  const { messages, nodes, edges, coreTask, userProfile } = req.body;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const handoffEdges = edges.filter(e => {
    const src = nodes.find(n => n.id === e.source);
    const tgt = nodes.find(n => n.id === e.target);
    return src && tgt && src.actor && tgt.actor && src.actor !== tgt.actor;
  });

  const nodeList = nodes.map(n => `  - [${n.type}] ${n.id} (${n.actor ?? '?'}): ${n.label}`).join('\n');
  const handoffList = handoffEdges.map(e => {
    const src = nodes.find(n => n.id === e.source);
    const tgt = nodes.find(n => n.id === e.target);
    return `  - ${src?.label} (${src?.actor}) → ${tgt?.label} (${tgt?.actor})`;
  }).join('\n');

  const systemMsg = `You are probing how work is handed off between people and systems in the CURRENT WORKFLOW TASK.

CONTEXT:
- Task: ${coreTask}
- Role: ${userProfile?.jobTitle}

WORKFLOW NODES:\n${nodeList}

HANDOFF POINTS (where actor changes):\n${handoffList || '(none identified yet)'}

YOUR GOAL: For each handoff point, understand the mechanics:
- How does the work move? (Slack message, email, GitHub notification, verbal, automatic trigger?)
- Who initiates it — the sender or the receiver?
- Is there anything that can go wrong at this transition?
- How does the receiver know the work is ready for them?

Ask about one handoff at a time. Keep questions short and conversational. When all handoffs are explored, ask: "Is there any coordination or communication that happens that we haven't captured?"`;

  try {
    const apiMessages = [
      { role: 'system', content: systemMsg },
      ...messages.map(m => ({ role: m.role, content: m.content })),
    ];
    const response = await client.chat.completions.create({
      model: SMALL_MODEL,
      tools: [TOOLS.find(t => t.function.name === 'suggest_nodes'), TOOLS.find(t => t.function.name === 'add_node'), TOOLS.find(t => t.function.name === 'add_edge')],
      messages: apiMessages,
    });
    const choice = response.choices[0];
    let finalText = choice.message.content || '';
    if (choice.finish_reason === 'tool_calls') {
      for (const call of choice.message.tool_calls) {
        const input = JSON.parse(call.function.arguments);
        if (call.function.name === 'suggest_nodes') {
          send('suggestions', { items: input.suggestions });
        } else {
          send('graph_update', { tool: call.function.name, input });
        }
      }
    }
    send('done', { message: finalText });
    res.end();
  } catch (err) {
    console.error(err);
    send('error', { error: err.message });
    res.end();
  }
});

app.post('/api/expand-task', async (req, res) => {
  const { taskLabel, coreTask, jobTitle } = req.body;
  try {
    const response = await client.chat.completions.create({
      model: SMALL_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'Break a workflow step into 3–5 concrete sequential subtasks. Return JSON: { "subtasks": [{ "id": "unique_snake_case", "label": "Short label (2-4 words)", "description": "One sentence" }] }',
        },
        {
          role: 'user',
          content: `Main workflow: ${coreTask}\nStep to expand: ${taskLabel}\nRole: ${jobTitle ?? 'professional'}`,
        },
      ],
    });
    const parsed = JSON.parse(response.choices[0].message.content);
    res.json({ subtasks: parsed.subtasks ?? [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/typical-workflow', async (req, res) => {
  const { jobTitle, coreTask } = req.body;
  try {
    const response = await client.chat.completions.create({
      model: SMALL_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'You are a workflow expert. Return JSON: { "steps": ["string"] } — an ordered list of 8–14 steps that represent a typical, complete workflow for this task in this role. Be specific and concrete. Cover the full flow including common branches and the final step.',
        },
        {
          role: 'user',
          content: `Role: ${jobTitle}\nTask: ${coreTask}`,
        },
      ],
    });
    const parsed = JSON.parse(response.choices[0].message.content);
    res.json({ steps: parsed.steps ?? [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/chat', async (req, res) => {
  const { messages, coreTask, nodes = [], skipSuggestions = false, userProfile = null, selectedTasks = [], typicalWorkflow = null } = req.body;

  // SSE setup
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.flush?.();
  };

  try {
    let suggestions = null;
    let currentNodeId = null;
    const nodeList = nodes.length === 0
      ? '(none yet)'
      : nodes.map(n => `  - [${n.type}] ${n.id}: ${n.label}`).join('\n');

    const systemMessage = {
      role: 'system',
      content: `${buildSystemPrompt(userProfile, selectedTasks, typicalWorkflow)}\n\nCURRENT WORKFLOW TASK: "${coreTask}"\nNODES IN GRAPH:\n${nodeList}`,
    };

    let apiMessages = [
      systemMessage,
      ...messages.map(m => ({ role: m.role, content: m.content })),
    ];

    let continueLoop = true;
    let finalText = '';

    while (continueLoop) {
      const response = await client.chat.completions.create({
        model: MODEL,
        tools: TOOLS,
        messages: apiMessages,
      });

      const choice = response.choices[0];

      if (choice.finish_reason === 'tool_calls') {
        const toolCalls = choice.message.tool_calls;
        const toolResults = [];

        for (const call of toolCalls) {
          const input = JSON.parse(call.function.arguments);

          if (call.function.name === 'suggest_nodes') {
            if (!skipSuggestions) {
              suggestions = { prompt: input.prompt || null, items: input.suggestions };
            }
          } else if (call.function.name === 'set_current_node') {
            currentNodeId = input.node_id;
            send('current_node', { nodeId: input.node_id });
          } else if (call.function.name === 'set_lanes') {
            send('set_lanes', { lanes: input.lanes });
          } else {
            // Stream graph updates immediately as they arrive
            send('graph_update', { tool: call.function.name, input });
            if (call.function.name === 'add_node') {
              const existing = nodes.find(n => n.id === input.id);
              if (!existing) nodes.push(input);
            }
          }

          toolResults.push({ role: 'tool', tool_call_id: call.id, content: 'Done.' });
        }

        apiMessages = [...apiMessages, choice.message, ...toolResults];
      } else {
        finalText = choice.message.content || '';
        continueLoop = false;
      }
    }

    // Guarantee suggestions if skipped
    if (!suggestions && !skipSuggestions) {
      const nodeList2 = nodes.length === 0
        ? '(none yet)'
        : nodes.map(n => `  - [${n.type}] ${n.id}: ${n.label}`).join('\n');
      const suggRes = await client.chat.completions.create({
        model: MODEL,
        max_tokens: 300,
        tools: [TOOLS.find(t => t.function.name === 'suggest_nodes')],
        tool_choice: { type: 'function', function: { name: 'suggest_nodes' } },
        messages: [
          {
            role: 'system',
            content: `${buildSystemPrompt(userProfile, selectedTasks, typicalWorkflow)}\n\nCurrent task: "${coreTask}". Current nodes:\n${nodeList2}\n\nThe assistant just said: "${finalText}"\n\nCall suggest_nodes with 2–4 options that directly answer the question just asked. Generate options from role knowledge — do NOT recycle the existing node labels.`,
          },
          ...messages.map(m => ({ role: m.role, content: m.content })),
          ...(finalText ? [{ role: 'assistant', content: finalText }] : []),
        ],
      });
      const call = suggRes.choices[0].message.tool_calls?.[0];
      if (call) {
        const input = JSON.parse(call.function.arguments);
        suggestions = { prompt: input.prompt || null, items: input.suggestions };
      }
    }

    send('done', { message: finalText, suggestions, currentNodeId });
    res.end();
  } catch (err) {
    console.error(err);
    send('error', { error: err.message });
    res.end();
  }
});

app.post('/api/transcribe', async (req, res) => {
  const { audio, mimeType = 'audio/webm' } = req.body;
  try {
    const buffer = Buffer.from(audio, 'base64');
    const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm';
    const tmpPath = path.join(os.tmpdir(), `audio_${Date.now()}.${ext}`);
    await fs.writeFile(tmpPath, buffer);
    let transcription;
    try {
      transcription = await client.audio.transcriptions.create({
        file: createReadStream(tmpPath),
        model: 'whisper-1',
      });
    } finally {
      fs.unlink(tmpPath).catch(() => {});
    }
    res.json({ text: transcription.text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Per-sessionId write queue — serializes concurrent saves for the same session
// so a debounced autosave and an unload-time sendBeacon can't race and produce
// a file with two JSON objects concatenated. Cheap (one Promise per session in
// flight) and short-lived (cleared as soon as the chain settles).
const sessionWriteQueue = new Map();

// True iff the payload carries no participant work — used to refuse overwrites
// of a session file with substantive state when a blank-store reload (e.g.
// back-button revisit before /api/resume hydration ships) tries to save itself
// over the top. A real participant's save always populates at least one of
// these slots.
function isMateriallyEmpty(d) {
  if (!d || typeof d !== 'object') return true;
  const phases = Object.keys(d.phaseEnteredAt || {});
  const beyondSetup = phases.some(p => p !== 'setup');
  if (beyondSetup) return false;
  if (d.userProfile && (d.userProfile.jobTitle || d.userProfile.typicalWeek || d.userProfile.responsibilities || d.userProfile.aiUsage)) return false;
  if (Array.isArray(d.backgroundTranscript) && d.backgroundTranscript.length > 0) return false;
  if (Array.isArray(d.selectedTasks) && d.selectedTasks.length > 0) return false;
  if (Array.isArray(d.taskItems) && d.taskItems.length > 0) return false;
  if (Array.isArray(d.taskWorkflows) && d.taskWorkflows.length > 0) return false;
  if (d.workflow && Array.isArray(d.workflow.nodes) && d.workflow.nodes.length > 0) return false;
  if (Array.isArray(d.transcript) && d.transcript.length > 0) return false;
  if (typeof d.coreTask === 'string' && d.coreTask.length > 0) return false;
  if (typeof d.feedback === 'string' && d.feedback.length > 0) return false;
  if (d.experienceRating != null) return false;
  return true;
}

// Read a previously-saved session snapshot so the SPA can rehydrate after a
// reload. Filename mirrors the POST handler: `${externalId}_${sessionId}.json`
// when externalId is set, else `${sessionId}.json`.
app.get('/api/session', async (req, res) => {
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
  if (!sessionId || !/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) {
    return res.status(400).json({ error: 'invalid sessionId' });
  }
  const rawExtId = typeof req.query.externalId === 'string' ? req.query.externalId : '';
  const safeExtId = rawExtId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  const baseName = safeExtId ? `${safeExtId}_${sessionId}` : sessionId;
  const filePath = path.join(SESSIONS_DIR, `${baseName}.json`);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(raw);
    res.json({ found: true, data });
  } catch (err) {
    if (err.code === 'ENOENT') return res.json({ found: false });
    console.error('[session] read failed:', err);
    res.status(500).json({ error: 'read failed' });
  }
});

app.post('/api/session', async (req, res) => {
  const { sessionId, ...rest } = req.body;
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId required' });
  }
  // Optional external participant ID (for recruits outside Prolific). Client
  // already sanitizes, but re-sanitize defensively so a hostile body can't
  // slip path separators or dots into the filename.
  const rawExtId = typeof rest.externalId === 'string' ? rest.externalId : '';
  const safeExtId = rawExtId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  const baseName = safeExtId ? `${safeExtId}_${sessionId}` : sessionId;
  const filePath = path.join(SESSIONS_DIR, `${baseName}.json`);
  const incoming = { sessionId, ...rest, savedAt: new Date().toISOString() };
  const payload = JSON.stringify(incoming, null, 2);
  // Chain this write onto whatever is already in flight for this sessionId,
  // then write atomically (temp file + rename) so partial writes can't be
  // observed by readers (or by a racing concurrent writer).
  const previous = sessionWriteQueue.get(sessionId) || Promise.resolve();
  let skipped = false;
  const next = previous
    .catch(() => {})
    .then(async () => {
      // Guard: don't let a blank-store revisit (back button → fresh load → no
      // hydration yet → debounced autosave or beacon fires with empty state)
      // wipe a file with real participant work. Read the existing file inside
      // the serialized write task so concurrent writers can't race us.
      if (isMateriallyEmpty(incoming)) {
        try {
          const raw = await fs.readFile(filePath, 'utf8');
          const existing = JSON.parse(raw);
          if (!isMateriallyEmpty(existing)) {
            console.warn('[session] refusing to overwrite non-empty file with empty payload', { sessionId, existingSavedAt: existing.savedAt });
            skipped = true;
            return;
          }
        } catch (err) {
          // ENOENT or unparseable existing file → fall through and write.
          if (err.code !== 'ENOENT') {
            console.warn('[session] guard read failed, proceeding with write:', err.message);
          }
        }
      }
      const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await fs.writeFile(tmpPath, payload);
      await fs.rename(tmpPath, filePath);
    });
  sessionWriteQueue.set(sessionId, next);
  try {
    await next;
    res.json({ ok: true, skipped });
  } catch (err) {
    console.error('[session] write failed:', err);
    res.status(500).json({ error: 'write failed' });
  } finally {
    // Drop the queue entry once it settles AND nothing newer is queued behind it.
    if (sessionWriteQueue.get(sessionId) === next) {
      sessionWriteQueue.delete(sessionId);
    }
  }
});

// In production, serve the Vite-built static frontend from the same Express
// process. In dev, Vite runs on a separate port and proxies /api/* to us.
if (process.env.NODE_ENV === 'production') {
  const distDir = path.join(__dirname, 'dist');
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.get('/health', (_req, res) => res.json({ ok: true }));

// Runtime config the SPA fetches on mount. Keep this minimal — anything sensitive
// stays server-side. Codes are shown in the URL we redirect to, so it's fine to
// return them to the client.
// Record a screen-out for a Prolific PID. Idempotent — repeat calls update timestamp.
app.post('/api/screen-out', async (req, res) => {
  const { pid, sessionId, reason } = req.body || {};
  const safe = safePid(pid);
  if (!safe) return res.status(400).json({ error: 'invalid pid' });
  const filePath = path.join(SCREEN_OUTS_DIR, `${safe}.json`);
  await fs.writeFile(
    filePath,
    JSON.stringify({ pid: safe, sessionId, reason, at: new Date().toISOString() }, null, 2),
  );
  res.json({ ok: true });
});

// Check whether a Prolific PID has been screened out previously. Used on app
// mount to lock out participants who refresh after failing an attention check.
app.get('/api/screen-status', async (req, res) => {
  const safe = safePid(req.query.pid);
  if (!safe) return res.json({ screenedOut: false });
  const filePath = path.join(SCREEN_OUTS_DIR, `${safe}.json`);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    res.json({ screenedOut: true, reason: parsed.reason ?? null, at: parsed.at ?? null });
  } catch (err) {
    if (err.code === 'ENOENT') return res.json({ screenedOut: false });
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/config', (_req, res) => {
  const rawMax = process.env.ATTN_CHECK_MAX_FAILS;
  const parsedMax = rawMax !== undefined && rawMax !== '' ? Number(rawMax) : 0;
  res.json({
    prolificCompletionCode: process.env.PROLIFIC_COMPLETION_CODE || null,
    prolificScreenOutCode: process.env.PROLIFIC_SCREENOUT_CODE || null,
    attnCheckMaxFails: Number.isFinite(parsedMax) ? parsedMax : 0,
  });
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
