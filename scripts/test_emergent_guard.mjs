// Multi-persona guard test for the emergent phase: run the live planner against several
// roles and LLM-judge each EMERGENT question — is it PRESUMPTUOUS (asks about a task the
// participant gave no signal of doing, i.e. a guess off the job title), GROUNDED (anchored
// to something they actually said), and SPECIFIC (names a concrete slice, not a vague
// catch-all)? A good guard => 0 presumptuous, and emergent questions grounded + specific.
import OpenAI from 'openai';
import { participant } from './planner_ab.mjs';
import { plannerStep } from '../prompts/planner.js';
import { PERSONAS } from './sim_interview.mjs';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const names = (process.env.PERSONAS || 'Concrete ER nurse,Terse engineer,Elementary teacher,Construction electrician,Social worker').split(',');

async function run(persona) {
  let r = await plannerStep(client, { turns: [], state: null });
  let state = r.state, q = r.question, phase = r.phase;
  const turns = [], history = [], recs = [];
  for (let i = 0; i < 20; i++) {
    const histBefore = history.join('\n');
    const ans = await participant(persona, q, history);
    history.push(`Interviewer: ${q}`, `Participant: ${ans}`);
    turns.push({ question: q, answer: ans });
    recs.push({ phase, question: q, answer: ans, histBefore });
    r = await plannerStep(client, { turns, state }); state = r.state;
    if (r.done || !r.question) break;
    q = r.question; phase = r.phase;
  }
  return recs;
}

async function judge(histBefore, question) {
  const r = await client.chat.completions.create({
    model: 'gpt-4o', temperature: 0, response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: `An interviewer asked the NEXT question below, given the transcript so far. Judge it on three axes:
- presumptuous: true if it asks about a task/area the participant has given NO signal of doing — a guess off their job title rather than grounded in what they actually said (this is the failure to catch).
- grounded: true if it's anchored to something they ACTUALLY described.
- specific: true if it names a concrete slice of work, false if it's a vague catch-all ("what are your daily responsibilities?").
Return JSON {"presumptuous":bool,"grounded":bool,"specific":bool,"reason":"<one short phrase>"}.` },
      { role: 'user', content: `TRANSCRIPT SO FAR:\n${histBefore || '(none)'}\n\nNEXT QUESTION:\n${question}` },
    ],
  });
  try { return JSON.parse(r.choices[0].message.content); } catch { return {}; }
}

console.log('\n========== EMERGENT GUARD TEST ==========');
let totEm = 0, totPre = 0, totGround = 0, totSpec = 0;
for (const nm of names) {
  const p = PERSONAS.find((x) => x.name === nm);
  if (!p) { console.log(`(persona not found: ${nm})`); continue; }
  const recs = await run(p);
  const em = recs.filter((x) => x.phase === 'emergent');
  console.log(`\n### ${nm}  (${recs.length} turns, ${em.length} emergent)`);
  for (const e of em) {
    const v = await judge(e.histBefore, e.question);
    totEm++; if (v.presumptuous) totPre++; if (v.grounded) totGround++; if (v.specific) totSpec++;
    const flag = v.presumptuous ? '❌ PRESUMPTUOUS' : '✅';
    console.log(`  ${flag} g=${v.grounded ? 'Y' : 'n'} s=${v.specific ? 'Y' : 'n'}  ${e.question}`);
    console.log(`        (${v.reason || ''})`);
  }
}
console.log(`\n=== TOTALS: ${totEm} emergent Qs | presumptuous ${totPre} (${totEm ? Math.round(totPre / totEm * 100) : 0}%) | grounded ${totGround} | specific ${totSpec} ===`);
