// Quantitative task-quality judge for the INTERVIEW pipeline.
//
// Unlike quality.mjs (which judges the fixed inventories.json for the O*NET-vs-ours
// comparison), this runs the LIVE pipeline on every real interview session —
//   extract-interview-tasks  →  generate-tasks-from-interview
// — and scores each GENERATED task with an LLM judge on two axes:
//
//   1. The analyst rubric (validation/rubric.json): singleActivity, generality,
//      clarity, actionOriented, faceValidity — binary pass/fail per criterion.
//   2. Groundedness against THIS participant's transcript: stated / inferable /
//      unsupported — catches hallucinated extractions and templated gap-fill.
//
// Results are broken down by task source (interview vs gap-fill) with Wilson CIs,
// so we can measure the effect of prompt changes (run before/after and compare).
//
// Requires the app server running (node --env-file=.env server.js).
//   node --env-file=.env validation/task_quality.mjs [--sessions a1b2,c3d4] [--min-turns 6] [--tag baseline]
import fs from 'fs/promises';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import { wilsonCI } from './lib/stats.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = path.join(__dirname, '..', 'sessions');
const API = process.env.SIM_API || 'http://localhost:3001';
const MODEL = process.env.QUALITY_MODEL || 'gpt-4o';
const CONCURRENCY = Number(process.env.QUALITY_CONCURRENCY) || 8;
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const ONLY = (arg('--sessions', '') || '').split(',').filter(Boolean);
const MIN_TURNS = Number(arg('--min-turns', '6'));
const TAG = arg('--tag', 'run');

// ── Load real interview sessions ──────────────────────────────────────────────
function loadSessions() {
  const out = [];
  for (const f of readdirSync(SESSIONS_DIR).filter((n) => n.endsWith('.json'))) {
    let s; try { s = JSON.parse(readFileSync(path.join(SESSIONS_DIR, f))); } catch { continue; }
    const bt = s.backgroundTranscript || [];
    if (bt.length < MIN_TURNS) continue;
    if (ONLY.length && !ONLY.some((p) => f.startsWith(p))) continue;
    out.push({ id: f.slice(0, 8), profile: s.userProfile || {}, bt });
  }
  return out.sort((a, b) => b.bt.length - a.bt.length);
}

function transcriptText(bt) {
  return bt.map((t) => {
    const q = (t.question || '').trim(), a = (t.answer || '').trim();
    return `Q: ${q}\nA: ${a || '(skipped)'}`;
  }).join('\n');
}

// ── Pipeline calls ────────────────────────────────────────────────────────────
async function extract(backgroundTranscript) {
  const r = await fetch(`${API}/api/extract-interview-tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backgroundTranscript }),
  });
  return (await r.json()).tasks ?? [];
}
async function generate(profile, interviewTasks, backgroundTranscript) {
  const res = await fetch(`${API}/api/generate-tasks-from-interview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jobTitle: profile.jobTitle, responsibilities: profile.responsibilities,
      typicalWeek: profile.typicalWeek, aiUsage: profile.aiUsage,
      interviewTasks, backgroundTranscript,
    }),
  });
  const text = await res.text();
  const tasks = [];
  for (const block of text.split('\n\n')) {
    const ev = block.match(/event: (\w+)/), dt = block.match(/data: (.+)/);
    if (ev && ev[1] === 'task' && dt) { const o = JSON.parse(dt[1]); tasks.push({ name: o.name, source: o.source || 'interview' }); }
  }
  return tasks;
}

// ── Judges ────────────────────────────────────────────────────────────────────
async function judgeRubric(statement, occupation, rubric) {
  const criteria = rubric.criteria.map((c) => `- ${c.key}: ${c.question}`).join('\n');
  const sys =
    `You are an occupational analyst reviewing task statements for the occupation "${occupation}". ` +
    `For the given task statement, judge each criterion as true (passes) or false (fails). ` +
    `Be a strict reviewer. Respond ONLY with JSON: an object whose keys are the criterion keys, ` +
    `each mapping to {"pass": boolean, "reason": short string}.\n\nCriteria:\n${criteria}`;
  const res = await client.chat.completions.create({
    model: MODEL, temperature: 0, response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: sys }, { role: 'user', content: `Task statement: "${statement}"` }],
  });
  return JSON.parse(res.choices[0].message.content);
}

// Transcript-aware groundedness: is this task supported by what the participant said?
async function judgeGrounded(statement, transcript) {
  const sys =
    `You verify whether a task statement is supported by an interview transcript of a worker describing their job. ` +
    `Classify the statement's groundedness as exactly one of:\n` +
    `- "stated": the participant explicitly described this activity (possibly in different words).\n` +
    `- "inferable": not stated, but a reasonable, specific inference from what THIS participant said about their work and background.\n` +
    `- "unsupported": generic role-filler or a leap not backed by anything this participant said (would apply to almost anyone with the title).\n` +
    `Be strict: if a task is a plausible thing for the occupation but nothing in THIS transcript points to it, that is "unsupported", not "inferable". ` +
    `Respond ONLY with JSON: {"level": "stated"|"inferable"|"unsupported", "reason": short string}.`;
  const res = await client.chat.completions.create({
    model: MODEL, temperature: 0, response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: `TRANSCRIPT:\n${transcript}\n\nTASK STATEMENT: "${statement}"` },
    ],
  });
  return JSON.parse(res.choices[0].message.content);
}

async function mapLimit(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const rubric = JSON.parse(await fs.readFile(path.join(__dirname, 'rubric.json'), 'utf-8'));
  const keys = rubric.criteria.map((c) => c.key);
  const sessions = loadSessions();
  process.stderr.write(`sessions: ${sessions.length} (min-turns ${MIN_TURNS})\n`);

  // 1. Run the pipeline, collect every generated task tagged by source + session.
  const rows = [];
  for (const s of sessions) {
    const occupation = (s.profile.jobTitle || 'worker').replace(/\s+/g, ' ').trim() || 'worker';
    const extracted = await extract(s.bt);
    const generated = await generate(s.profile, extracted, s.bt);
    process.stderr.write(`  ${s.id}: extracted ${extracted.length} → generated ${generated.length}\n`);
    for (const g of generated) rows.push({ session: s.id, occupation, transcript: transcriptText(s.bt), ...g });
  }

  // 2. Judge every task (rubric + groundedness) concurrently.
  const graded = await mapLimit(rows, CONCURRENCY, async (r) => {
    const [rub, grd] = await Promise.all([
      judgeRubric(r.name, r.occupation, rubric),
      judgeGrounded(r.name, r.transcript),
    ]);
    return {
      session: r.session, name: r.name, source: r.source,
      scores: Object.fromEntries(keys.map((k) => [k, !!(rub[k] && rub[k].pass)])),
      reasons: Object.fromEntries(keys.map((k) => [k, rub[k] && rub[k].reason])),
      grounded: grd.level, groundedReason: grd.reason,
    };
  });

  const outDir = path.join(__dirname, 'out', 'task_quality');
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, `${TAG}.json`), JSON.stringify(graded, null, 2));

  // 3. Aggregate per source (interview / gap / all).
  const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : '—');
  const cell = (r) => `${pct(r.p)} [${pct(r.lo)},${pct(r.hi)}]`.padEnd(20);
  function summarize(items) {
    const n = items.length;
    const perCrit = Object.fromEntries(keys.map((k) => {
      const pass = items.filter((g) => g.scores[k]).length;
      return [k, wilsonCI(pass, n)];
    }));
    const allPass = items.filter((g) => keys.every((k) => g.scores[k])).length;
    const g = (lvl) => items.filter((x) => x.grounded === lvl).length;
    return { n, perCrit, allPass: wilsonCI(allPass, n),
             grounded: { stated: g('stated'), inferable: g('inferable'), unsupported: g('unsupported') } };
  }
  const groups = {
    all: summarize(graded),
    interview: summarize(graded.filter((g) => g.source === 'interview')),
    gap: summarize(graded.filter((g) => g.source === 'gap')),
  };

  const cols = ['interview', 'gap', 'all'];
  console.log(`\nTask-quality judge  [tag: ${TAG}, judge: ${MODEL}, ${sessions.length} sessions]\n`);
  console.log('criterion'.padEnd(22) + cols.map((c) => `${c} (n=${groups[c].n})`.padEnd(20)).join(''));
  console.log('-'.repeat(22 + 20 * cols.length));
  for (const c of rubric.criteria) {
    console.log(c.label.padEnd(22) + cols.map((col) => cell(groups[col].perCrit[c.key])).join(''));
  }
  console.log('ALL criteria pass'.padEnd(22) + cols.map((col) => cell(groups[col].allPass)).join(''));
  console.log('-'.repeat(22 + 20 * cols.length));
  console.log('Groundedness:');
  for (const lvl of ['stated', 'inferable', 'unsupported']) {
    console.log(`  ${lvl}`.padEnd(22) + cols.map((col) => {
      const gg = groups[col].grounded; const tot = groups[col].n;
      return `${pct(tot ? gg[lvl] / tot : NaN)} (${gg[lvl]})`.padEnd(20);
    }).join(''));
  }
  console.log(`\nwrote ${path.relative(process.cwd(), path.join(outDir, `${TAG}.json`))}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
