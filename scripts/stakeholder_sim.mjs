// Focused simulation for the STAKEHOLDERS pass:
//  (A) the kinds of questions/follow-ups it generates across diverse occupations
//  (B) the AUTO-SKIP coverage eval (/api/check-coverage) — does the pass get
//      skipped when earlier answers already cover it, and asked when they don't?
// Usage: node scripts/stakeholder_sim.mjs [baseUrl]   (default localhost:3001)

import OpenAI from 'openai';
import { readFileSync } from 'node:fs';

if (!process.env.OPENAI_API_KEY) {
  try {
    for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
      const m = line.match(/^\s*OPENAI_API_KEY\s*=\s*(.+)\s*$/);
      if (m) process.env.OPENAI_API_KEY = m[1].replace(/^["']|["']$/g, '').trim();
    }
  } catch {}
}
const BASE = process.argv[2] || 'http://localhost:3001';
const openai = new OpenAI();

const TOPIC = {
  text: 'Who do you do your work for or with — the people, teams, or clients you deal with?',
  maxFollowups: 3,
  minFollowups: 1,
  criteria: [
    "FLOOR — the participant has named at least one person, team, role, or outside party they do work for or with. If they named NONE ('I mostly work alone', 'no one really'), follow up warmly asking who they work for or with, even occasionally.",
    "BREADTH — surface the RANGE of people, not just one: if they named only their immediate team, follow up ONCE asking whether there are others they work for or with — people they depend on, people who depend on them, or anyone outside their team or organization (clients, customers, partners). If they named several distinct parties, breadth is covered.",
    "INTERACTION SUBSTANCE — for the main relationships, it should be clear WHAT the working relationship actually involves task-wise: what they do with or for that person or group (hand off to, coordinate with, report to, support, get input or feedback from). When a stakeholder is named only as a bare label with no sense of the actual exchange, follow up ONCE: warmly pick the SINGLE most central one and ask what they actually do with or for them. Probe ONE relationship per turn, never skeptically. If the main relationships already carry concrete substance, this is covered.",
  ],
};

const PERSONAS = [
  { name: 'ICU Nurse', blurb: 'an ICU nurse. Answer naturally in 1-2 sentences.',
    prior: 'Interviewer: What are your primary responsibilities?\nParticipant: I monitor critically ill patients, administer medications, and respond to emergencies.\nInterviewer: Walk me through a typical week.\nParticipant: I do patient assessments, chart vitals, give meds, and update care plans each shift.' },
  { name: 'Backend Engineer', blurb: 'a backend software engineer. Answer naturally in 1-2 sentences.',
    prior: 'Interviewer: What are your primary responsibilities?\nParticipant: I own the payments service and its APIs.\nInterviewer: Walk me through a typical week.\nParticipant: I write services, review PRs, fix incidents, and plan the roadmap with my team.' },
  { name: 'Freelance Graphic Designer', blurb: 'a freelance graphic designer. Answer naturally in 1-2 sentences.',
    prior: 'Interviewer: What are your primary responsibilities?\nParticipant: I design brand identities and marketing materials for clients.\nInterviewer: Walk me through a typical week.\nParticipant: I take briefs, design logos and assets, and send drafts for review.' },
  { name: 'High School Principal', blurb: 'a high school principal. Answer naturally in 1-2 sentences.',
    prior: 'Interviewer: What are your primary responsibilities?\nParticipant: I run the school — staffing, budget, student outcomes, and discipline.\nInterviewer: Walk me through a typical week.\nParticipant: I observe classes, meet staff, handle parent issues, and review data.' },
];

async function answer(blurb, convo, q) {
  const r = await openai.chat.completions.create({ model: 'gpt-4o-mini', temperature: 0.5,
    messages: [{ role: 'system', content: `You are role-playing a participant. You are ${blurb} Output ONLY the answer text.` },
      { role: 'user', content: `${convo}\n\nInterviewer: ${q}\n\nYour answer:` }] });
  return r.choices[0].message.content.trim();
}
async function evaluate(combined, fc, conversation) {
  const r = await fetch(`${BASE}/api/evaluate-answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: TOPIC.text, answer: combined, criteria: TOPIC.criteria, maxFollowups: TOPIC.maxFollowups, followupCount: fc, evaluationStyle: 'lenient', conversation, minFollowups: TOPIC.minFollowups }) });
  return r.json();
}
async function checkCoverage(conversation) {
  const r = await fetch(`${BASE}/api/check-coverage`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: TOPIC.text, criteria: TOPIC.criteria, conversation }) });
  return r.json();
}

console.log('\n########## PART A — stakeholder follow-ups across occupations ##########');
for (const p of PERSONAS) {
  console.log(`\n${'='.repeat(70)}\n${p.name}`);
  let convo = p.prior;
  let a = await answer(p.blurb, convo, TOPIC.text);
  convo += `\nInterviewer: ${TOPIC.text}\nParticipant: ${a}`;
  console.log(`  Q: ${TOPIC.text}`);
  console.log(`     A: ${a}`);
  let combined = a, fc = 0;
  while (fc < TOPIC.maxFollowups) {
    const res = await evaluate(combined, fc, convo);
    if (res.allCovered || !res.followUp) break;
    fc++;
    const fa = await answer(p.blurb, convo, res.followUp);
    convo += `\nInterviewer: ${res.followUp}\nParticipant: ${fa}`;
    combined += `\n${fa}`;
    console.log(`  ↳ FOLLOW-UP: ${res.followUp}`);
    console.log(`     A: ${fa}`);
  }
}

console.log('\n\n########## PART B — AUTO-SKIP coverage eval (/api/check-coverage) ##########');
const COVERAGE_CASES = [
  { name: 'ALREADY covers stakeholders (expect SKIP)',
    convo: 'Interviewer: Walk me through a typical week.\nParticipant: I meet with my product manager to align on priorities, hand finished designs off to the engineering team to build, send drafts to clients for approval, and check in with the customer success team about feedback. I depend on the data team for analytics and the legal team signs off on contracts.' },
  { name: 'Mentions tasks but NOT who (expect ASK)',
    convo: 'Interviewer: Walk me through a typical week.\nParticipant: I write reports, clean data, build dashboards, and run models. Mostly heads-down analysis work at my desk.' },
  { name: 'Thin transcript (expect ASK)',
    convo: 'Interviewer: What are your primary responsibilities?\nParticipant: I help out wherever needed.' },
];
for (const c of COVERAGE_CASES) {
  const res = await checkCoverage(c.convo);
  console.log(`\n  ${res.covered ? 'SKIP ' : 'ASK  '}  covered=${res.covered}  — ${c.name}`);
  console.log(`        reason: ${res.reason}`);
}
console.log('');
