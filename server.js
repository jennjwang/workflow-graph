import OpenAI from 'openai';
import express from 'express';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '25mb' }));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.MODEL || 'gpt-4o-mini';

const SESSIONS_DIR = path.join(__dirname, 'sessions');
await fs.mkdir(SESSIONS_DIR, { recursive: true });

function buildSystemPrompt(userProfile = null, selectedTasks = []) {
  const profileCtx = userProfile
    ? `\n\nPARTICIPANT PROFILE:\n- Role: ${userProfile.jobTitle} (${userProfile.tenure})\n- Typical week: ${userProfile.typicalWeek}`
    : '';

  return `You are an expert workflow analyst helping a research participant map out their work process as a directed graph. Your goal is to understand and visualize how they complete the CURRENT WORKFLOW TASK — from start to finish — including all decision points and branches.${profileCtx}

INTERACTION MODEL (most important):
- On your FIRST message only: ask the participant to walk you through the CURRENT WORKFLOW TASK from start to finish in their own words. One open question, no choices yet. Do NOT call suggest_nodes on the first turn.
- On every subsequent message: call suggest_nodes with 3–4 specific answer choices the user can pick from, based on what they've said so far. Choices must be concrete and role-specific.
- Always include a mix of types: mostly 'task' steps, and a 'decision' option where a branch or condition is plausible.
- After the first open question, keep follow-up text to 1–2 sentences and let the choices carry the conversation.

GRAPH BUILDING (equally critical):
- Call add_node and add_edge IMMEDIATELY whenever the user picks an option or describes any step.
- On your very first response, add a 'start' node for the task being mapped.
- Node IDs: short snake_case. Types: 'start', 'task', 'decision'.
- Use 'decision' nodes where the flow splits. Set is_branch=true on edges leaving a decision onto a non-main path.

CONVERSATION FLOW:
- Keep text brief — choices and graph carry the conversation.
- When the workflow feels complete, ask: "Does this capture everything? Any missing paths?"`;
}



const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'suggest_nodes',
      description: 'Offer the user a set of suggested next steps to pick from, shown as clickable chips in the UI. Call this when the user gives a short or vague response, seems uncertain, or when proactively offering likely next steps after a section completes.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Short prompt shown above the chips, e.g. "What comes next?" or "Here are some common next steps:"' },
          suggestions: {
            type: 'array',
            description: '2–4 concrete, specific suggestions tailored to this workflow',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Short step label (2–5 words)' },
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
          type: { type: 'string', enum: ['start', 'task', 'decision'] },
          label: { type: 'string', description: 'Short display label (2-5 words)' },
          description: { type: 'string', description: 'One sentence explaining what happens here' },
        },
        required: ['id', 'type', 'label', 'description'],
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
  const { question, answer, criteria, maxFollowups = 1, followupCount = 0 } = req.body;
  try {
    // Never follow up beyond the allowed limit
    if (followupCount >= maxFollowups) {
      return res.json({ allCovered: true, followUp: null });
    }

    const criteriaList = criteria.map((c, i) => `${i + 1}. ${c}`).join('\n');

    const response = await client.chat.completions.create({
      model: MODEL,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are evaluating whether a participant's answer satisfies a set of coverage criteria.

Rules:
- Be lenient. If the answer partially or indirectly addresses a criterion, treat it as covered.
- A vague, short, or general answer is still an answer — do NOT re-ask just to get more depth.
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

const TASK_BATCH_SIZE = 6;
const TASK_MIN_BATCHES = 4;
const TASK_MAX_BATCHES = 12;

app.post('/api/generate-tasks', async (req, res) => {
  const { jobTitle, tenure, typicalWeek, batchIndex = 0, priorTasks = [] } = req.body;
  try {
    const priorBlock = priorTasks.length > 0
      ? `Previously shown tasks (do NOT repeat these):\n${priorTasks.map(t => `- ${t}`).join('\n')}\n\n`
      : '';

    const batchHint = batchIndex < 2
      ? 'Focus on the most common, high-frequency tasks central to this role.'
      : 'Focus on a different dimension of the role — coordination, documentation, reactive work, or specialized tasks not yet covered.';

    const stopHint = batchIndex >= TASK_MIN_BATCHES
      ? 'If the role is well-covered and you have nothing meaningfully new to add, return fewer than 6 tasks and set has_more to false.'
      : `Set has_more to true (minimum ${TASK_MIN_BATCHES} batches required).`;

    const response = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.9,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are a job analyst generating tasks for a workflow study.

Rules:
- Tasks must be DISTINCT — no two tasks should describe the same activity even with different wording
- Each task: 5–12 words, starts with an action verb, sentence case
- Be specific — include object and context where helpful
  Good: "Review pull requests and leave code comments"
  Bad: "Review code"
- Return ONLY valid JSON: {"tasks": [{"name": "Task name here"}, ...], "has_more": true}`,
        },
        {
          role: 'user',
          content: `Job title: ${jobTitle}\nTenure: ${tenure}\nTypical week: ${typicalWeek}\n\n${priorBlock}${batchHint}\n${stopHint}\n\nGenerate ${TASK_BATCH_SIZE} tasks.`,
        },
      ],
    });
    const parsed = JSON.parse(response.choices[0].message.content);
    const hasMore = batchIndex < TASK_MAX_BATCHES - 1 && (parsed.has_more !== false);
    res.json({ tasks: parsed.tasks ?? [], has_more: hasMore });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/chat', async (req, res) => {
  const { messages, coreTask, nodes = [], skipSuggestions = false, userProfile = null, selectedTasks = [] } = req.body;

  try {
    const graphUpdates = [];
    let suggestions = null;
    const nodeList = nodes.length === 0
      ? '(none yet)'
      : nodes.map(n => `  - [${n.type}] ${n.id}: ${n.label}`).join('\n');

    const systemMessage = {
      role: 'system',
      content: `${buildSystemPrompt(userProfile, selectedTasks)}\n\nCURRENT WORKFLOW TASK: "${coreTask}"\nNODES IN GRAPH:\n${nodeList}`,
    };

    let apiMessages = [
      systemMessage,
      ...messages.map(m => ({ role: m.role, content: m.content })),
    ];

    // Agentic tool-use loop
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
          } else {
            graphUpdates.push({ tool: call.function.name, input });
            if (call.function.name === 'add_node') {
              const existing = nodes.find(n => n.id === input.id);
              if (!existing) nodes.push(input);
            }
          }

          toolResults.push({
            role: 'tool',
            tool_call_id: call.id,
            content: 'Done.',
          });
        }

        apiMessages = [...apiMessages, choice.message, ...toolResults];
      } else {
        finalText = choice.message.content || '';
        continueLoop = false;
      }
    }

    // Guarantee suggestions via a forced tool_choice call if the model skipped them
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
            content: `${buildSystemPrompt(userProfile, selectedTasks)}\n\nCurrent task: "${coreTask}". Current nodes:\n${nodeList2}\n\nCall suggest_nodes with 3–4 specific, concrete next steps that would logically follow in this workflow for a ${userProfile?.jobTitle || 'professional'}. Mix task and decision types as appropriate.`,
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

    res.json({ message: finalText, graphUpdates, suggestions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
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
  const { sessionId, coreTask, workflow, messages } = req.body;
  const filePath = path.join(SESSIONS_DIR, `${sessionId}.json`);
  await fs.writeFile(
    filePath,
    JSON.stringify({ sessionId, coreTask, workflow, messages, savedAt: new Date().toISOString() }, null, 2)
  );
  res.json({ ok: true });
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
