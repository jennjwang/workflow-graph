// Gap-task generation — the "generate to discover" half of the streaming picker.
//
// Given a worker's profile and the tasks ALREADY COVERED for them (bank tasks drawn by
// active learning ∪ tasks they mentioned ∪ tasks already shown), generate the role-coverage
// GAPS — broad recurring tasks clearly implied by their responsibilities/typical week that
// the covered set does NOT touch. This is what lets a cold-start (empty-bank) draw still
// fill the role, and what discovers tasks the bank doesn't yet hold so online harvest can
// fold them in.
//
// Generalizes the gap-fill that was inlined in /api/generate-tasks-stream: there "covered"
// was only the interview-mentioned tasks; here it also includes bank-drawn tasks, so the
// generator never re-proposes something the bank already covers.
//
// Reuses UPPER_LEVEL_TASKS_SYSTEM_PROMPT (the shape/altitude rules) + the careful
// semantic-overlap grounding. Streams JSONL so the picker renders incrementally.
import OpenAI from 'openai';
import { UPPER_LEVEL_TASKS_SYSTEM_PROMPT } from './prompts/task-generator.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.MODEL || 'gpt-4o-mini';

function groundingBlock(covered) {
  if (!covered.length) return '';
  return (
    `\nTASKS ALREADY COVERED for this worker (what they mentioned + what we have already shown them):\n` +
    `${covered.map(t => `- ${t}`).join('\n')}\n\n` +
    `REDEFINED MECE TARGET FOR THIS RUN: Treat the covered tasks above as ALREADY-PRESENT upper-level tasks. ` +
    `Your output PLUS the covered tasks together must be MECE over the role. Your output's role is to fill the GAPS — ` +
    `categories of work clearly implied by the worker's responsibilities and typical week that the covered set does NOT touch.\n\n` +
    `SEMANTIC OVERLAP — READ CAREFULLY (most common failure mode):\n` +
    `  When you check "is my proposed task the same as one already covered?", compare MEANING, not wording. Two tasks are the ` +
    `SAME ACTIVITY when a worker would describe the same minute of their day with either label. Surface differences do not make them different activities.\n\n` +
    `  Examples of COVERED ↔ DO-NOT-OUTPUT pairs:\n` +
    `    Covered "do code reviews"      → DO NOT output "Review pull requests" / "Review code".\n` +
    `    Covered "answer Slack messages" → DO NOT output "Respond to team chat" / "Reply to teammates".\n` +
    `    Covered "go to standup"        → DO NOT output "Attend daily standups" / "Join team standup".\n` +
    `    Covered "implement tickets"    → DO NOT output "Build features" / "Write code for tickets".\n` +
    `  TEST: for each task you draft, scan every covered task and ask "could a worker honestly say this is the same thing?" If yes for any, drop yours.\n\n` +
    `Concretely:\n` +
    `  1. DO NOT output an upper-level task that semantically overlaps with a covered task, even if the wording or framing differs.\n` +
    `  2. DO output upper-level tasks for any role-relevant category the covered set does NOT touch.\n` +
    `  3. STAY IN THEIR WORLD. Your gap-fill tasks must be clearly implied by their responsibilities or typical week.\n` +
    `  4. If the covered set already exhausts the role's major categories, emit FEWER items (it is fine to emit none).\n`
  );
}

const STREAM_SUFFIX = `

OUTPUT FORMAT — STREAMING (overrides any earlier JSON instructions):
Emit ONE JSON object per line. Each line: {"name":"<task name>"}. NO outer array, NO commas between objects, NO surrounding {"tasks":[...]}. Emit them as you decide on them — don't pre-buffer the full set.`;

/**
 * Stream gap tasks for a worker, excluding everything already covered.
 * @param profile  { jobTitle, responsibilities, typicalWeek, aiUsage }
 * @param covered  string[] tasks already covered (bank-drawn ∪ mentioned ∪ shown)
 * @param onTask   (name) => void   called per gap task as it streams
 * @returns number of tasks emitted
 */
export async function streamGapTasks({ profile, covered = [], onTask }) {
  const { jobTitle, responsibilities, typicalWeek, aiUsage } = profile;
  const user =
    `Job: ${jobTitle}` +
    (responsibilities ? `\nPrimary responsibilities: ${responsibilities}` : '') +
    `\nTypical week: ${typicalWeek}` +
    (aiUsage ? `\nAI usage: ${aiUsage}` : '') +
    groundingBlock(covered) +
    `\nGenerate the gap-filling upper-level tasks.`;

  const stream = await openai.chat.completions.create({
    model: MODEL, temperature: 0.7, stream: true,
    messages: [
      { role: 'system', content: UPPER_LEVEL_TASKS_SYSTEM_PROMPT + STREAM_SUFFIX },
      { role: 'user', content: user },
    ],
  });

  let buffer = '', emitted = 0;
  const emitLine = (line) => {
    const t = line.trim();
    if (!t) return;
    try {
      const o = JSON.parse(t);
      if (o && typeof o.name === 'string' && o.name.trim()) { onTask(o.name.trim()); emitted++; }
    } catch { /* tolerate stray non-JSON chunks */ }
  };
  for await (const chunk of stream) {
    buffer += chunk.choices?.[0]?.delta?.content ?? '';
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      emitLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  if (buffer.trim()) emitLine(buffer);
  return emitted;
}
