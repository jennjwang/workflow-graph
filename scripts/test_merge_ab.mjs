// A/B the LIVE planner (prompts/planner.js plannerStep) with the merged strike+generate
// turns ON vs OFF, reusing the harness's participant simulator + scoring (judgeQuestions,
// goldSet/coverage). The merge lives only in plannerStep, so we drive that directly.
//
//   PLANNER_MERGE_FIRST_N=4 node --env-file=.env scripts/test_merge_ab.mjs   # merged
//   PLANNER_MERGE_FIRST_N=0 node --env-file=.env scripts/test_merge_ab.mjs   # separate
//   PERSONAS="Terse engineer" ... to pick personas (default: the 3 hard ones)
import OpenAI from 'openai';
import { participant, goldSet, extract, coverage, judgeQuestions } from './planner_ab.mjs';
import { plannerStep } from '../prompts/planner.js';
import { PERSONAS } from './sim_interview.mjs';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MERGE = process.env.PLANNER_MERGE_FIRST_N ?? '4';
const names = (process.env.PERSONAS || 'Rambling over-explainer,One-word answerer,Terse engineer').split(',');

// Drive the live plannerStep with the persona simulator as the participant.
async function runLive(persona) {
  let r = await plannerStep(client, { turns: [], state: null });
  let state = r.state, q = r.question;
  const turns = [], history = [];
  for (let i = 0; i < 22; i++) {
    const ans = await participant(persona, q, history);
    history.push(`Interviewer: ${q}`, `Participant: ${ans}`);
    turns.push({ question: q, answer: ans });
    r = await plannerStep(client, { turns, state });
    state = r.state;
    if (r.done || !r.question) break;
    q = r.question;
  }
  return turns;
}

console.log(`\n========== MERGE_FIRST_N=${MERGE} (${MERGE === '0' ? 'all separate' : 'first ' + MERGE + ' merged'}) ==========`);
const rows = [];
for (const nm of names) {
  const p = PERSONAS.find((x) => x.name === nm);
  if (!p) { console.log(`(persona not found: ${nm})`); continue; }
  const turns = await runLive(p);
  const gold = await goldSet(p);
  const [tasks, qual] = await Promise.all([extract(turns, { jobTitle: gold.jobTitle }), judgeQuestions(turns)]);
  const cov = await coverage(gold.gold, tasks);
  rows.push({ nm, t: turns.length, cov, ...qual });
  console.log(`${nm.padEnd(26)} ${String(turns.length).padStart(2)}t  cov=${Math.round(cov * 100)}%  open=${Math.round(qual.openPct * 100)}%  lead=${Math.round(qual.leadingPct * 100)}%  redun=${Math.round(qual.redundantPct * 100)}%  clear=${Math.round(qual.clearPct * 100)}%`);
}
const a = (k) => Math.round((rows.reduce((s, r) => s + r[k], 0) / rows.length) * 100);
const aT = (rows.reduce((s, r) => s + r.t, 0) / rows.length).toFixed(1);
console.log(`${'AVG'.padEnd(26)} ${aT}t  cov=${a('cov')}%  open=${a('openPct')}%  lead=${a('leadingPct')}%  redun=${a('redundantPct')}%  clear=${a('clearPct')}%`);
