// Full planner interviews across personas, focused on the two fixes just made:
//   1) NO META / PEER-COMPARISON question ("how do your tasks differ from others
//      in your profession?", "anything you do that they don't?") — emergent guard.
//   2) Callbacks only on FOLLOW-UPS — a new-topic question must NOT open by
//      restating/editorializing their role ("Research is your main area; ...").
// Prints the FULL transcript per persona (phase-tagged), then an LLM verdict per
// question. Run with PLANNER_MODEL=gpt-5.4-2026-03-05 to mirror the deploy target.
import OpenAI from 'openai';
import { participant } from './planner_ab.mjs';
import { plannerStep } from '../prompts/planner.js';
import { PERSONAS } from './sim_interview.mjs';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const names = (process.env.PERSONAS ||
  'Concrete ER nurse,Terse engineer,Rambling over-explainer,Vague founder').split(',');

// Cheap pre-filter for the obvious meta/peer-comparison shape.
const META_RE = /(others|other people|peers|colleagues|someone else)[^.?!]*\b(in (your|the same)|your (profession|role|field|line))|differ from|that (they|others) don'?t|you do that they|unique (to|about) (your|you)|compared to (other|your peers)/i;

async function run(persona) {
  let r = await plannerStep(client, { turns: [], state: null });
  let state = r.state, q = r.question, phase = r.phase;
  const turns = [], history = [], recs = [];
  for (let i = 0; i < 20; i++) {
    const histBefore = history.join('\n');
    const ans = await participant(persona, q, history);
    history.push(`Interviewer: ${q}`, `Participant: ${ans}`);
    turns.push({ question: q, answer: ans });
    recs.push({ phase, question: q, answer: ans, histBefore, meta: META_RE.test(q) });
    r = await plannerStep(client, { turns, state }); state = r.state;
    if (r.done || !r.question) break;
    q = r.question; phase = r.phase;
  }
  return recs;
}

// LLM judge: is this question a banned META/peer-comparison, and (for non-follow-up
// turns) does it improperly open by restating/editorializing the participant's role?
async function judge(histBefore, question, phase) {
  const r = await client.chat.completions.create({
    model: 'gpt-4o', temperature: 0, response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: `Judge the NEXT interview question.
- meta: true if it asks the participant to compare themselves to OTHERS in their profession/role, or to name their own gaps / what's "unique" about their work ("how do your tasks differ from others?", "anything you do that they don't?"). This framing is BANNED.
- editorializingCallback: true if it OPENS by restating or asserting a conclusion about the participant's role ("Research is the main area you own; ...", "So you mostly do X — ...") rather than just asking. A light reference while drilling the SAME thread is fine; asserting what their job "mainly is" is not.
Return JSON {"meta":bool,"editorializingCallback":bool,"reason":"<short phrase>"}.` },
      { role: 'user', content: `PHASE: ${phase}\nTRANSCRIPT SO FAR:\n${histBefore || '(none)'}\n\nNEXT QUESTION:\n${question}` },
    ],
  });
  try { return JSON.parse(r.choices[0].message.content); } catch { return {}; }
}

const all = await Promise.all(names.map(async (name) => {
  const persona = PERSONAS.find((p) => p.name === name) || { name, brief: name };
  const recs = await run(persona);
  const verdicts = await Promise.all(recs.map((x) => judge(x.histBefore, x.question, x.phase)));
  return { name, recs, verdicts };
}));

let metaCount = 0, editCount = 0, total = 0;
for (const { name, recs, verdicts } of all) {
  console.log(`\n${'='.repeat(78)}\n${name}  —  ${recs.length} questions\n${'='.repeat(78)}`);
  recs.forEach((x, i) => {
    const v = verdicts[i] || {};
    total++;
    const flags = [];
    if (v.meta || x.meta) { flags.push('META/PEER-COMPARISON'); metaCount++; }
    if (v.editorializingCallback) { flags.push('EDITORIALIZING-CALLBACK'); editCount++; }
    const tag = flags.length ? `  <<< ${flags.join(' + ')} (${v.reason || ''})` : '';
    console.log(`\n[${x.phase}] Q: ${x.question}${tag}`);
    console.log(`      A: ${x.answer}`);
  });
}
console.log(`\n${'='.repeat(78)}`);
console.log(`SUMMARY: ${total} questions across ${all.length} personas`);
console.log(`  META / peer-comparison flagged: ${metaCount}   (target: 0)`);
console.log(`  Editorializing new-topic callbacks: ${editCount}   (target: 0)`);
