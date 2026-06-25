// Run the live planner against simulated users GROUNDED IN REAL recent sessions.
// For each session we build a persona from the participant's ACTUAL answers, then
// an LLM role-plays that exact person while the real planner drives the interview.
// Surfaces the things we've been fixing: META/peer-comparison, editorializing
// new-topic callbacks, and REPEATED (near-duplicate) questions.
//
//   PLANNER_MODEL=gpt-5.4-2026-03-05 node --env-file=.env scripts/sim_from_sessions.mjs [N]
//   SESSIONS="42512f45,7d0def62" node --env-file=.env scripts/sim_from_sessions.mjs
import OpenAI from 'openai';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { plannerStep } from '../prompts/planner.js';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PARTICIPANT_MODEL = process.env.SIM_PARTICIPANT_MODEL || 'gpt-4o-mini';
const DIR = new URL('../sessions/', import.meta.url);

// Pick sessions: explicit SESSIONS=prefix,prefix or the latest N substantive ones.
function pickSessions() {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.json'))
    .map((f) => ({ f, m: statSync(new URL(f, DIR)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  const want = (process.env.SESSIONS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (want.length) return files.filter((x) => want.some((w) => x.f.startsWith(w))).map((x) => x.f);
  const N = Number(process.argv[2]) || 3;
  const out = [];
  for (const { f } of files) {
    const s = JSON.parse(readFileSync(new URL(f, DIR)));
    if ((s.backgroundTranscript || []).length >= 8) out.push(f);
    if (out.length >= N) break;
  }
  return out;
}

// Build a persona brief from a session's real profile + verbatim answers.
function personaFromSession(file) {
  const s = JSON.parse(readFileSync(new URL(file, DIR)));
  const p = s.userProfile || {};
  const bt = s.backgroundTranscript || [];
  const role = p.jobTitle || '(role given in their answers)';
  const facts = bt.filter((t) => t.answer && t.answer.trim())
    .map((t) => `- ${t.answer.trim()}`).join('\n');
  const brief = `You are role-playing a REAL interview participant. Their role: ${role}.
Here is what THIS person actually said about their work in a prior interview — treat it as ground truth about who you are:
${facts}

Answer the interviewer AS this person. Stay consistent with the facts above; match their concision and tone. When asked about something not covered above, answer plausibly for THIS specific person/role in the same style — do NOT invent a different job. Don't dump everything at once; answer the question asked.`;
  return { name: `${role} [${file.slice(0, 8)}]`, brief, role };
}

async function participant(persona, question, history) {
  const r = await client.chat.completions.create({
    model: PARTICIPANT_MODEL, temperature: 0.6,
    messages: [
      { role: 'system', content: persona.brief },
      { role: 'user', content: `Interview so far:\n${history.join('\n') || '(just starting)'}\n\nInterviewer: ${question}\n\nAnswer in 1-3 sentences, in character.` },
    ],
  });
  return r.choices[0].message.content.trim();
}

// Normalize a question for near-duplicate detection (lowercase, strip callbacks/punct).
const norm = (q) => q.toLowerCase()
  .replace(/^(earlier you said|you mentioned|coming back to|let'?s go back to|about|going back to)[^,—-]*[,—-]\s*/i, '')
  .replace(/[^a-z0-9 ]/g, '').replace(/\b(the|a|an|your|you|do|usually|actually|what|are|is|for|of|in|to|that|this)\b/g, '')
  .replace(/\s+/g, ' ').trim();

async function dupJudge(qA, qB) {
  const r = await client.chat.completions.create({
    model: 'gpt-4o', temperature: 0, response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: 'Two interview questions. Are they asking for essentially the SAME information (a reworded repeat), such that a participant would feel they already answered it? Return JSON {"duplicate":bool,"reason":"<short>"}.' },
      { role: 'user', content: `A: ${qA}\nB: ${qB}` }],
  });
  try { return JSON.parse(r.choices[0].message.content); } catch { return {}; }
}

async function run(persona) {
  let r = await plannerStep(client, { turns: [], state: null });
  let state = r.state, q = r.question, phase = r.phase;
  const recs = [], history = [];
  for (let i = 0; i < 20; i++) {
    const ans = await participant(persona, q, history);
    history.push(`Interviewer: ${q}`, `Participant: ${ans}`);
    recs.push({ phase, question: q, answer: ans });
    const turns = recs.map((x) => ({ question: x.question, answer: x.answer }));
    r = await plannerStep(client, { turns, state }); state = r.state;
    if (r.done || !r.question) break;
    q = r.question; phase = r.phase;
  }
  // Flag near-duplicate question pairs (cheap norm prefilter, then LLM confirm).
  const dups = [];
  for (let i = 0; i < recs.length; i++) for (let j = i + 1; j < recs.length; j++) {
    const a = norm(recs[i].question), b = norm(recs[j].question);
    if (!a || !b) continue;
    const overlap = a.split(' ').filter((w) => w && b.split(' ').includes(w)).length;
    if (overlap >= Math.min(a.split(' ').length, b.split(' ').length) * 0.6) {
      const v = await dupJudge(recs[i].question, recs[j].question);
      if (v.duplicate) dups.push([i, j, v.reason]);
    }
  }
  return { recs, dups };
}

const files = pickSessions();
console.log(`Sessions: ${files.map((f) => f.slice(0, 8)).join(', ')}\n`);
let totalDups = 0, totalQ = 0;
for (const file of files) {
  const persona = personaFromSession(file);
  const { recs, dups } = await run(persona);
  totalQ += recs.length; totalDups += dups.length;
  console.log(`${'='.repeat(78)}\n${persona.name}  —  ${recs.length} questions\n${'='.repeat(78)}`);
  const dupMark = new Map();
  dups.forEach(([i, j, why]) => { dupMark.set(j, `<<< REPEAT of Q${i + 1} (${why})`); });
  recs.forEach((x, i) => {
    console.log(`\n[${x.phase}] Q${i + 1}: ${x.question}  ${dupMark.get(i) || ''}`);
    console.log(`      A: ${x.answer}`);
  });
  if (dups.length) {
    console.log(`\n  REPEATS in this interview: ${dups.length}`);
    dups.forEach(([i, j, why]) => console.log(`   Q${i + 1} ≈ Q${j + 1}: ${why}`));
  }
}
console.log(`\n${'='.repeat(78)}\nSUMMARY: ${totalQ} questions across ${files.length} session-grounded users`);
console.log(`  Repeated/near-duplicate questions: ${totalDups}   (target: 0)`);
