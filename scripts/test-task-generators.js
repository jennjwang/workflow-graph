// Compare upper-level task generation strategies on the same role:
//   (1) one-shot tightened — single LLM call with strong constraints
//   (2) two-pass: responsibility areas → tasks per area
//   (3) one-shot + critique — generate, then a second call asks "what's missing?"
//   (4) areas-as-tasks (MECE) — broad responsibility areas as the upper-level tasks
//
// Usage:
//   node scripts/test-task-generators.js [fixtureName]            # all four
//   node scripts/test-task-generators.js [fixtureName] --only 4   # just strategy 4
//   node scripts/test-task-generators.js [fixtureName] --only 1,4 # subset
//
// Requires OPENAI_API_KEY in env (run with `node --env-file=.env scripts/test-task-generators.js`).

import OpenAI from 'openai';
import { UPPER_LEVEL_TASKS_SYSTEM_PROMPT } from '../prompts/task-generator.js';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.MODEL || 'gpt-4o-mini';
const TASK_COUNT = 15;
const AREA_COUNT = 6;

const FIXTURES = {
  'phd-student': {
    jobTitle: 'PhD student in machine learning',
    tenure: '3 years',
    typicalWeek:
      'I read recent papers, debug research code, run experiments, meet with my advisor weekly, and present updates at lab meeting. I also draft sections for an upcoming paper and mentor a couple of undergrads.',
  },
  'school-nurse': {
    jobTitle: 'School nurse',
    tenure: '8 years',
    typicalWeek:
      'I see kids who come in feeling sick, manage medications throughout the day, handle minor injuries, and update health records. I also run vision/hearing screenings periodically and coordinate with parents about chronic conditions.',
  },
  'product-manager': {
    jobTitle: 'Senior product manager at a fintech startup',
    tenure: '4 years',
    typicalWeek:
      'I write PRDs, run sprint planning and standups, sync with engineering and design, review metrics dashboards, and talk to customers. I also write quarterly roadmaps and review competitor releases.',
  },
  'barista': {
    jobTitle: 'Barista at a specialty coffee shop',
    tenure: '2 years',
    typicalWeek:
      'I open the cafe, dial in espresso, take orders and pull shots, restock pastry case, clean equipment, and close out the till at the end of the day. I also help train new baristas and run the occasional latte-art class.',
  },
  'electrician': {
    jobTitle: 'Residential electrician',
    tenure: '12 years',
    typicalWeek:
      'I drive to job sites, diagnose wiring issues in homes, run new circuits, install fixtures and panels, pull permits and schedule inspections, and write up invoices for customers at the end of the day.',
  },
  'theory-phd': {
    jobTitle: 'PhD student in theoretical computer science',
    tenure: '4 years',
    typicalWeek:
      'I read papers, prove theorems on a whiteboard, write up proofs in LaTeX, and meet with my advisor. I do NOT run experiments or write production code — my work is purely theoretical.',
  },
};

// ─── Strategy 1: one-shot tightened ───────────────────────────────────────────
const SHARED_RULES = `
GROUND IN THE ROLE. Every task must reference an artifact, tool, person, or output specific to THIS role and industry.

PLAIN LANGUAGE. Write the way the participant would say it to a coworker. Avoid corporate-speak.

NEUTRAL PHRASING. Never use "our", "my", or "the team's" — use neutral articles ("the codebase", "a colleague's PR").

ONE THING PER TASK. Each task is a single concrete activity. NEVER use " and " to compound two actions.

LENGTH. 3–8 words, action verb, sentence case.

NON-OVERLAPPING. Each task is a DISTINCT ACTIVITY at the level the participant would describe their work, NOT a sub-step or stage of another task.
- THE TEST: imagine someone in this role saying "yes I do X but no I don't do Y" about your two tasks. If both always go together for everyone in this role, drop one.
`.trim();

const DECOMPOSE_RULE = `
DECOMPOSABLE GRANULARITY. Each task should be at a level that decomposes into 3–5 concrete sub-steps. Not too small ("send an email"), not too big ("manage projects"). A new hire should look at one and think "that's a thing I'd need to learn how to do."
`.trim();

async function strategy1OneShot({ jobTitle, tenure, typicalWeek }) {
  const sys = `You are generating upper-level tasks that someone with this exact job actually does in a typical week. The tasks will later be decomposed into sub-steps, so granularity matters.

${SHARED_RULES}

${DECOMPOSE_RULE}

COMPLETENESS — IMPORTANT. Imagine the person's full week and produce a set that COVERS the role. Before finalizing, mentally check: "If this person only had these tasks visible, would whole categories of their work be missing?" If yes, add the missing categories.

BIAS TOWARD WHAT THEY MENTIONED. Use the participant's typical-week answer to weight which tasks belong — if they mentioned mentoring, include something mentor-shaped — but don't be limited to it; include role-typical tasks they didn't mention.

Sample BREADTH across the domain — different artifacts, audiences, contexts, frequencies — not depth into one activity.

Return ONLY valid JSON: {"tasks": [{"name": "..."}]}`;

  const user = `Job: ${jobTitle}\nTenure: ${tenure}\nTypical week: ${typicalWeek}\n\nGenerate ${TASK_COUNT} upper-level tasks.`;

  const resp = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.8,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
  });
  return JSON.parse(resp.choices[0].message.content).tasks ?? [];
}

// ─── Strategy 2: areas → tasks ────────────────────────────────────────────────
async function strategy2Areas({ jobTitle, tenure, typicalWeek }) {
  // Pass A: produce 5–7 responsibility areas.
  const areasSys = `You are mapping the responsibility areas of a job — the broad categories of work someone in this role does over a week or month. These are NOT individual tasks; they're parents that contain multiple tasks.

Examples for a Software Engineer: "Writing code", "Code review", "Debugging", "Design & architecture", "Deployment & operations", "Communication & meetings", "Learning & technical reading".

Examples for an Elementary School Teacher: "Lesson planning", "In-class teaching", "Grading & feedback", "Parent & family communication", "Student behavior management", "Administrative paperwork", "Professional development".

Each area:
- Is 1–4 words, noun-phrase, sentence case
- Is mutually distinct from the others
- Together with the others, COVERS the typical week of someone in this role
- Could plausibly contain 2–4 concrete tasks beneath it

BIAS — but don't restrict — to areas the participant mentioned in their typical-week answer.

Return ONLY valid JSON: {"areas": [{"name": "..."}]}`;

  const areasUser = `Job: ${jobTitle}\nTenure: ${tenure}\nTypical week: ${typicalWeek}\n\nGenerate ${AREA_COUNT} responsibility areas that together cover this role's work.`;

  const areasResp = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.6,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: areasSys },
      { role: 'user', content: areasUser },
    ],
  });
  const areas = (JSON.parse(areasResp.choices[0].message.content).areas ?? [])
    .map((a) => a.name)
    .filter(Boolean);

  if (areas.length === 0) return [];

  // Pass B: under each area, generate concrete tasks.
  const perArea = Math.max(2, Math.ceil(TASK_COUNT / areas.length));
  const tasksSys = `You are generating concrete tasks under specified responsibility areas of a job. Each task is ONE thing the person actually does within that area.

${SHARED_RULES}

${DECOMPOSE_RULE}

Tasks must clearly belong to the area they're listed under. Do NOT repeat tasks across areas.

BIAS toward what the participant mentioned in their typical week, but include role-typical tasks they didn't mention so the set is complete.

Return ONLY valid JSON of the shape:
{"tasks_by_area": [{"area": "...", "tasks": [{"name": "..."}]}]}`;

  const tasksUser = `Job: ${jobTitle}\nTenure: ${tenure}\nTypical week: ${typicalWeek}\n\nResponsibility areas:\n${areas.map((a, i) => `${i + 1}. ${a}`).join('\n')}\n\nGenerate ${perArea} tasks under each area (so ~${perArea * areas.length} total). If an area genuinely has fewer concrete tasks, give fewer rather than padding.`;

  const tasksResp = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.7,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: tasksSys },
      { role: 'user', content: tasksUser },
    ],
  });
  const grouped =
    JSON.parse(tasksResp.choices[0].message.content).tasks_by_area ?? [];
  const flat = [];
  for (const group of grouped) {
    for (const t of group.tasks ?? []) {
      if (t?.name) flat.push({ name: t.name, area: group.area });
    }
  }
  return { areas, tasks: flat.slice(0, TASK_COUNT) };
}

// ─── Strategy 4: areas-as-tasks (MECE) ────────────────────────────────────────
// Uses the SHARED prompt (prompts/task-generator.js) — same one server.js
// /api/generate-tasks runs in production. Edit there to change both at once.
async function strategy4AreasAsTasks({ jobTitle, tenure, typicalWeek }) {
  const sys = UPPER_LEVEL_TASKS_SYSTEM_PROMPT;
  const user = `Job: ${jobTitle}\nTenure: ${tenure}\nTypical week: ${typicalWeek}\n\nGenerate the upper-level tasks.`;

  const resp = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.7,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
  });
  return JSON.parse(resp.choices[0].message.content).tasks ?? [];
}

// ─── Strategy 3: one-shot + critique ──────────────────────────────────────────
async function strategy3Critique(profile) {
  // Reuse the one-shot generator (a) for the initial set.
  const initial = await strategy1OneShot(profile);

  const critiqueSys = `You are reviewing a list of upper-level tasks generated for someone in this job. Your job is to identify what's MISSING from the set — categories of work that the original generator didn't include but should have.

Look for:
- Whole categories of work that aren't represented (e.g. learning/training, admin paperwork, communication with external parties, regular reporting)
- Important rhythms (daily/weekly/monthly) that have no task
- Audiences or stakeholders missing (junior coworkers, customers, vendors, regulators)

For each missing category, propose a concrete task name that fits the same style as the existing list.

${SHARED_RULES}

${DECOMPOSE_RULE}

Return ONLY valid JSON: {"additional_tasks": [{"name": "...", "fills_gap": "..."}]}. fills_gap is a short label for what category this fills (e.g. "external comms", "monthly reporting", "learning"). Output 0–6 additional tasks — do NOT pad if the set is already complete.`;

  const critiqueUser = `Job: ${profile.jobTitle}\nTenure: ${profile.tenure}\nTypical week: ${profile.typicalWeek}\n\nInitial tasks:\n${initial.map((t, i) => `${i + 1}. ${t.name}`).join('\n')}\n\nWhat's missing?`;

  const critiqueResp = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.6,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: critiqueSys },
      { role: 'user', content: critiqueUser },
    ],
  });
  const additions =
    JSON.parse(critiqueResp.choices[0].message.content).additional_tasks ?? [];
  return { initial, additions };
}

// ─── Driver ───────────────────────────────────────────────────────────────────
function parseArgs() {
  const argv = process.argv.slice(2);
  let fixtureName = 'phd-student';
  let only = new Set([1, 2, 3, 4]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only') {
      const v = argv[++i] || '';
      only = new Set(
        v
          .split(',')
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= 4),
      );
    } else if (!a.startsWith('--')) {
      fixtureName = a;
    }
  }
  if (only.size === 0) only = new Set([1, 2, 3, 4]);
  return { fixtureName, only };
}

async function main() {
  const { fixtureName, only } = parseArgs();
  const profile = FIXTURES[fixtureName];
  if (!profile) {
    console.error(
      `Unknown fixture "${fixtureName}". Choices: ${Object.keys(FIXTURES).join(', ')}`,
    );
    process.exit(1);
  }

  console.log('═'.repeat(72));
  console.log(`Profile: ${profile.jobTitle} (${profile.tenure})`);
  console.log(`Typical week: ${profile.typicalWeek}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Strategies: ${[...only].sort().join(', ')}`);
  console.log('═'.repeat(72));

  const t0 = Date.now();
  const [s1, s2, s3, s4] = await Promise.all([
    only.has(1) ? strategy1OneShot(profile) : Promise.resolve(null),
    only.has(2) ? strategy2Areas(profile) : Promise.resolve(null),
    only.has(3) ? strategy3Critique(profile) : Promise.resolve(null),
    only.has(4) ? strategy4AreasAsTasks(profile) : Promise.resolve(null),
  ]);
  const elapsed = Date.now() - t0;

  console.log(`\nFinished in ${(elapsed / 1000).toFixed(1)}s (parallel runs).\n`);

  if (s1) {
    console.log('─'.repeat(72));
    console.log('STRATEGY 1 — One-shot, tightened constraints');
    console.log('─'.repeat(72));
    s1.forEach((t, i) => console.log(`  ${String(i + 1).padStart(2)}. ${t.name}`));
    console.log();
  }

  if (s2) {
    console.log('─'.repeat(72));
    console.log('STRATEGY 2 — Two-pass: responsibility areas → tasks');
    console.log('─'.repeat(72));
    console.log(`Areas (${s2.areas.length}):`);
    s2.areas.forEach((a, i) => console.log(`  ${i + 1}. ${a}`));
    console.log(`\nTasks (${s2.tasks.length}):`);
    let curArea = null;
    for (const t of s2.tasks) {
      if (t.area !== curArea) {
        console.log(`  [${t.area}]`);
        curArea = t.area;
      }
      console.log(`     • ${t.name}`);
    }
    console.log();
  }

  if (s3) {
    console.log('─'.repeat(72));
    console.log('STRATEGY 3 — One-shot + critique');
    console.log('─'.repeat(72));
    console.log(`Initial pass (${s3.initial.length}):`);
    s3.initial.forEach((t, i) =>
      console.log(`  ${String(i + 1).padStart(2)}. ${t.name}`),
    );
    console.log(`\nAdded by critique (${s3.additions.length}):`);
    s3.additions.forEach((t, i) =>
      console.log(
        `  ${String(i + 1).padStart(2)}. ${t.name}   ← fills: ${t.fills_gap || '?'}`,
      ),
    );
    console.log();
  }

  if (s4) {
    console.log('─'.repeat(72));
    console.log('STRATEGY 4 — Areas-as-tasks (broad, decomposable upper level)');
    console.log('─'.repeat(72));
    s4.forEach((t, i) => console.log(`  ${String(i + 1).padStart(2)}. ${t.name}`));
    console.log();
  }

  console.log('═'.repeat(72));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
