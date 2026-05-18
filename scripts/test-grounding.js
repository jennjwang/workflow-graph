// Tests whether the generator's "complement, don't echo" rule actually works
// when interview-extracted tasks are passed as grounding context.
//
// Mirrors the prompt construction inside server.js's /api/generate-tasks
// (system prompt + user message with the grounding block) so this is an
// apples-to-apples preview of the live endpoint.
//
// Usage:
//   node --env-file=.env scripts/test-grounding.js [scenario]
//   node --env-file=.env scripts/test-grounding.js phd-research-heavy
//   node --env-file=.env scripts/test-grounding.js phd-teaching-heavy

import OpenAI from 'openai';
import { UPPER_LEVEL_TASKS_SYSTEM_PROMPT } from '../prompts/task-generator.js';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.MODEL || 'gpt-4o-mini';

// Each scenario captures (a) the participant profile and (b) a plausible set
// of activities the extractor would have pulled from their interview. The
// pattern of the interviewTasks is deliberately skewed (research-heavy /
// teaching-heavy) so we can see whether the generator fills in the OTHER
// areas of the role.
const SCENARIOS = {
  'phd-research-heavy': {
    label: 'PhD student who described almost only research activities',
    profile: {
      jobTitle: 'PhD student in machine learning',
      responsibilities:
        'Conduct machine learning research that produces publishable results, advance my dissertation, and mentor undergraduate researchers in the lab.',
      typicalWeek:
        'I read recent papers, debug research code, run experiments, meet with my advisor weekly, and present updates at lab meeting. I also draft sections for an upcoming paper and mentor a couple of undergrads.',
    },
    interviewTasks: [
      'Read recent machine learning papers',
      'Debug research code',
      'Run experiments',
      'Analyze experimental results',
      'Draft paper sections',
    ],
  },
  'phd-teaching-heavy': {
    label: 'PhD student who described almost only teaching/mentoring',
    profile: {
      jobTitle: 'PhD student in machine learning',
      responsibilities:
        'Conduct machine learning research that produces publishable results, advance my dissertation, and mentor undergraduate researchers in the lab.',
      typicalWeek:
        'I spend a lot of time mentoring three undergrads on their projects, holding office hours for the class I TA, grading problem sets, and writing recommendation letters when alumni ask.',
    },
    interviewTasks: [
      'Mentor undergraduate researchers',
      'Hold office hours',
      'Grade problem sets',
      'Write recommendation letters',
    ],
  },
  'school-nurse-clinical': {
    label: 'School nurse who described clinical activities only',
    profile: {
      jobTitle: 'School nurse',
      responsibilities:
        'Provide health services to students throughout the school day, including treating injuries, managing medications, and supporting students with chronic conditions.',
      typicalWeek:
        'I see kids who come in feeling sick, manage medications throughout the day, handle minor injuries, and update health records.',
    },
    interviewTasks: [
      'Treat minor injuries',
      'Manage student medications',
      'Update health records',
      'Triage sick students',
    ],
  },
};

function buildUserMessage(profile, interviewTasks) {
  const groundingBlock = interviewTasks.length > 0
    ? `\nACTIVITIES THE PARTICIPANT ALREADY MENTIONED in the open interview:\n${interviewTasks.map(t => `- ${t}`).join('\n')}\n\n` +
      `REDEFINED MECE TARGET FOR THIS RUN: Treat the mentioned activities above as ALREADY-PRESENT upper-level tasks. Your output PLUS the mentioned activities together must be MECE over the role. Your output's role is to fill the GAPS — categories of work clearly implied by the participant's responsibilities and typical week that they did NOT explicitly mention.\n\n` +
      `Concretely:\n` +
      `  1. DO NOT output an upper-level task that is the same activity as one of the mentioned activities. The mentioned set is already covering it.\n` +
      `  2. DO output upper-level tasks for any role-relevant category the mentioned set does NOT touch (admin, communication, periodic reporting, learning, coordination, equipment upkeep, mandated compliance, anything in their responsibilities the typical week doesn't cover, etc.).\n` +
      `  3. STAY IN THEIR WORLD. Your gap-fill tasks must be clearly implied by their responsibilities or typical week — not imported from outside the role.\n` +
      `  4. If the mentioned set already exhausts the role's major categories, output FEWER tasks (even just 2–3). Better to output a short list than to manufacture overlap.\n` +
      `  5. COUNT: aim for total (mentioned + your output) ≈ 12–14. If mentioned has 5, output 7–9. If mentioned has 10, output 2–4.\n`
    : '';

  return (
    `Job: ${profile.jobTitle}\n` +
    `Primary responsibilities: ${profile.responsibilities}\n` +
    `Typical week: ${profile.typicalWeek}\n` +
    groundingBlock +
    `\nGenerate the upper-level tasks.`
  );
}

// Heuristic overlap check: does the generator output mention the same verb+key
// noun as one of the interviewTasks? Not strict semantic matching, but enough
// to flag "the model echoed this one" cases for manual review.
function overlapScore(generated, mentioned) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(w => w.length > 2);
  const mTokens = new Set(norm(mentioned));
  const gTokens = norm(generated);
  let hits = 0;
  for (const t of gTokens) if (mTokens.has(t)) hits++;
  return hits;
}

async function runScenario(name) {
  const scenario = SCENARIOS[name];
  if (!scenario) {
    console.error(`Unknown scenario "${name}". Choices: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(1);
  }

  console.log('═'.repeat(72));
  console.log(`SCENARIO: ${name}`);
  console.log(`  ${scenario.label}`);
  console.log('═'.repeat(72));
  console.log('\nProfile:');
  console.log(`  Job: ${scenario.profile.jobTitle}`);
  console.log(`  Responsibilities: ${scenario.profile.responsibilities}`);
  console.log(`  Typical week: ${scenario.profile.typicalWeek}`);
  console.log('\nExtracted from interview (passed as grounding context):');
  scenario.interviewTasks.forEach(t => console.log(`  - ${t}`));

  const userContent = buildUserMessage(scenario.profile, scenario.interviewTasks);

  const response = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.7,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: UPPER_LEVEL_TASKS_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
  });

  const parsed = JSON.parse(response.choices[0].message.content);
  const tasks = parsed.tasks ?? [];

  console.log('\nGenerator output (★ = likely echoes a mentioned activity):\n');
  let echoes = 0;
  tasks.forEach((task, i) => {
    const name = task.name ?? String(task);
    const maxOverlap = Math.max(0, ...scenario.interviewTasks.map(m => overlapScore(name, m)));
    const echoMark = maxOverlap >= 2 ? '★' : ' ';
    if (maxOverlap >= 2) echoes++;
    console.log(`  ${echoMark} ${String(i + 1).padStart(2)}. ${name}`);
  });

  console.log('\nSummary:');
  console.log(`  Total generator tasks: ${tasks.length}`);
  console.log(`  Likely echoes of mentioned activities: ${echoes}`);
  console.log(`  Apparently new/complementary: ${tasks.length - echoes}`);
  console.log('');
}

const args = process.argv.slice(2);
const scenarioName = args[0] ?? 'phd-research-heavy';
runScenario(scenarioName).catch(err => {
  console.error(err);
  process.exit(1);
});
