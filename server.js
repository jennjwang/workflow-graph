import OpenAI from 'openai';
import express from 'express';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { UPPER_LEVEL_TASKS_SYSTEM_PROMPT } from './prompts/task-generator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '25mb' }));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.MODEL || 'gpt-4o-mini';

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
  const { question, answer, criteria, maxFollowups = 1, followupCount = 0, evaluationStyle = 'lenient' } = req.body;
  try {
    // Never follow up beyond the allowed limit
    if (followupCount >= maxFollowups) {
      return res.json({ allCovered: true, followUp: null });
    }

    const criteriaList = criteria.map((c, i) => `${i + 1}. ${c}`).join('\n');

    const styleRules = evaluationStyle === 'strict'
      ? `- Apply the criteria as written. A vague, generic, or one-line answer that does NOT explicitly mention the concrete details a criterion calls for is NOT covered.
- If the answer is missing concrete specifics the criterion asks for (e.g. tools, collaborators, deliverables, cadence), it counts as uncovered — probe for them.
- Do not invent depth that isn't there: "I do meetings and emails" does not satisfy a criterion that asks for specific tools or recurring deliverables.`
      : `- Be lenient. If the answer partially or indirectly addresses a criterion, treat it as covered.
- A vague, short, or general answer is still an answer — do NOT re-ask just to get more depth.`;

    const response = await client.chat.completions.create({
      model: MODEL,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are evaluating whether a participant's answer satisfies a set of coverage criteria.

Rules:
${styleRules}
- If the answer is missing specific required information, generate ONE brief, natural follow-up question targeting ONLY the most critical unmet criterion.
- The follow-up must be one sentence, conversational, not a survey question, and must NOT ask for PII.
- Never ask double-barreled questions (one thing at a time).

Return JSON: { "allCovered": boolean, "followUp": string | null }`,
        },
        {
          role: 'user',
          content: `Question asked: "${question}"\nParticipant's answer: "${answer}"\n\nCoverage criteria:\n${criteriaList}\n\nAre all criteria satisfied? If not, what single follow-up question gets the most critical missing info?`,
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

app.post('/api/generate-categories', async (req, res) => {
  const { jobTitle, typicalWeek } = req.body;
  try {
    const response = await client.chat.completions.create({
      model: MODEL,
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

app.post('/api/generate-tasks', async (req, res) => {
  const { jobTitle, typicalWeek, aiUsage, priorTasks = [] } = req.body;
  try {
    const priorBlock = priorTasks.length > 0
      ? `\nAlready shown (do NOT repeat or paraphrase):\n${priorTasks.map(t => `- ${t}`).join('\n')}\n`
      : '';

    // MECE areas-as-tasks: each task is a broad responsibility area, written as a
    // verb-led activity. The set is mutually exclusive and collectively exhaustive
    // over the role's typical week. Each task will later be decomposed into 3–5
    // concrete sub-steps, so we deliberately avoid sub-step granularity here.
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
          content: `Job: ${jobTitle}\nTypical week: ${typicalWeek}${aiUsage ? `\nAI usage: ${aiUsage}` : ''}\n${priorBlock}\nGenerate the upper-level tasks.`,
        },
      ],
    });
    const parsed = JSON.parse(response.choices[0].message.content);
    res.json({ tasks: parsed.tasks ?? [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/propose-subtasks', async (req, res) => {
  const { taskLabel, coreTask, jobTitle, statementClarification, existingNodes = [] } = req.body;
  // statementClarification: optional string — if the user clarified what the vague task means
  const ctx = statementClarification
    ? `The participant clarified that "${taskLabel}" means: "${statementClarification}". Now propose 3–5 concrete sub-steps for this clarified task.`
    : `Propose 3–5 concrete sub-steps that make up "${taskLabel}" in the context of ${coreTask}.`;
  const existingList = existingNodes.length > 0
    ? `\n\nOTHER EXISTING NODES IN THE GRAPH (besides "${taskLabel}"):\n${existingNodes.map(n => `- id: ${n.id} | label: "${n.label}" | type: ${n.type}`).join('\n')}\n\nIMPORTANT: If a sub-step you'd propose is essentially the same as one of these existing nodes, DO NOT create it as a new sub-step. Instead, mark it as a connection to that existing node by setting "linkToExistingId" to the existing node's id. The system will draw an edge from the parent to that existing node instead of creating a duplicate.`
    : '';
  try {
    const response = await client.chat.completions.create({
      model: MODEL,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You propose BPMN-lite sub-steps for a workflow task. Return JSON: { "subtasks": [{ "label": "string (2-5 words)", "description": "one sentence", "type": "start" | "task" | "decision" | "handoff" | "wait" | "failure" | "end", "linkToExistingId": "string (optional)" }] }.

Use the right BPMN element type for each step:
- "task" — most common; a concrete action the person performs.
- "decision" — a branching point where flow splits based on a condition.
- "handoff" — work moves to another person, team, or system.
- "wait" — pauses for external event (approval, response, timer).
- "failure" — error or exception path.

CRITICAL DEDUP RULES:
- Look at the OTHER EXISTING NODES list. For each potential sub-step, check whether it OVERLAPS in MEANING with any existing node — not just exact labels. E.g. "Evaluate code quality" overlaps with an existing "Examine code style" or "Review code" node, even though the words differ.
- If a sub-step overlaps with an existing node: OMIT it entirely. Don't create a duplicate, don't even link to it.
- NEVER propose a sub-step that conceptually belongs under a DIFFERENT existing parent.
- NEVER propose a sub-step with the same label as the parent task being expanded.

MUTUAL EXCLUSIVITY (just as critical):
- The sub-steps you propose must be MUTUALLY EXCLUSIVE — each one covers a distinct concern, not a different angle of the same concern.
- BAD examples (too similar to each other): "Check code functionality" + "Examine tests" + "Assess code readability" — these all touch on aspects of "review the code" and overlap.
- GOOD examples for "Review code" (distinct concerns): "Read PR description" → "Run code locally" → "Add inline comments" → "Mark review status". Each is a different ACTION at a different phase.
- Test: if you can read two of your sub-steps and a person could plausibly be doing both at the same moment, they overlap — replace one.
- Each sub-step should be a different ACTION/STEP, not a different LENS on the same action.

SPECIFICITY (just as critical):
- Sub-step labels MUST describe a CONCRETE, OBSERVABLE action — something a new employee could literally watch you do.
- BANNED vague verbs in labels (when standing alone): "assess", "analyze", "evaluate", "consider", "review", "examine", "understand", "look at", "think about", "verify", "ensure" — these without a specific object/artifact are too abstract.
- BANNED vague phrases: "potential impacts", "key considerations", "relevant factors", "appropriate criteria", "the situation".
- Each label should answer: WHAT specifically is read, written, clicked, run, sent, opened, called, filed, or filled in?
- BAD: "Assess potential impacts" — what does this look like in practice?
- GOOD: "Read affected user count from analytics dashboard" or "Check Slack #incidents for related reports" or "Open the design doc and list every dependency".
- BAD: "Evaluate code quality"
- GOOD: "Run linter locally" or "Check test coverage report" or "Verify type-check passes".
- The 'description' field can elaborate, but the LABEL itself must already be concrete.

CRITICAL: only use type "decision" when the flow ACTUALLY BRANCHES based on the answer (e.g. "Approve or request changes?" — yes leads one way, no another). A "check" or "verify" step is a TASK, not a decision, unless the result truly splits the flow into different paths. When in doubt, use "task". Decision labels MUST be phrased as a question (end with "?", e.g. "Approve PR?", "Tests passing?", "Major change?").

Order: roughly sequential. Prefer 3–5 sub-steps.`,
        },
        { role: 'user', content: `Role: ${jobTitle}\nMain workflow: ${coreTask}\n\n${ctx}${existingList}` },
      ],
    });
    const parsed = JSON.parse(response.choices[0].message.content);
    const validTypes = new Set(['start', 'task', 'decision', 'handoff', 'wait', 'failure', 'end']);
    const existingIds = new Set(existingNodes.map(n => n.id));

    // Build a fuzzy-match index of existing nodes by normalized label
    const normalize = (s) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const labelToId = new Map();
    for (const n of existingNodes) {
      labelToId.set(normalize(n.label), n.id);
    }

    // The current task being expanded — never propose it as a subtask of itself
    const currentNorm = normalize(taskLabel);

    const seenNormalized = new Set();
    const subtasks = (parsed.subtasks ?? [])
      .map(s => {
        const norm = normalize(s.label);
        // Server-side fallback: if AI proposed a label matching an existing node, set linkToExistingId
        let link = existingIds.has(s.linkToExistingId) ? s.linkToExistingId : undefined;
        if (!link && labelToId.has(norm)) link = labelToId.get(norm);
        return {
          label: s.label ?? '',
          description: s.description ?? '',
          type: validTypes.has(s.type) ? s.type : 'task',
          linkToExistingId: link,
          _norm: norm,
        };
      })
      // Drop duplicates within the response and self-references
      .filter(s => {
        if (s._norm === currentNorm) return false; // proposing the parent itself as a sub-step
        if (seenNormalized.has(s._norm)) return false;
        seenNormalized.add(s._norm);
        return true;
      })
      .map(({ _norm, ...rest }) => rest);
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
      model: MODEL,
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
      model: MODEL,
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
      model: MODEL,
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
      model: MODEL,
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

app.post('/api/suggest-actors', async (req, res) => {
  const { transcript, jobTitle } = req.body;
  try {
    const response = await client.chat.completions.create({
      model: MODEL,
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
      model: MODEL,
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
      model: MODEL,
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
      model: MODEL,
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

app.post('/api/session', async (req, res) => {
  const { sessionId, ...rest } = req.body;
  const filePath = path.join(SESSIONS_DIR, `${sessionId}.json`);
  await fs.writeFile(
    filePath,
    JSON.stringify({ sessionId, ...rest, savedAt: new Date().toISOString() }, null, 2)
  );
  res.json({ ok: true });
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
