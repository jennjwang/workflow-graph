#!/usr/bin/env node
// Tests the follow-up loop for the responsibilities + tasks questions by driving
// the live /api/evaluate-answer endpoint with an LLM-simulated participant.
//
// Replicates the frontend loop in BackgroundInterview.tsx: keep evaluating until
// allCovered (with minFollowups satisfied) or maxFollowups is hit. We run a VAGUE
// persona (should be pushed toward the max) and a THOROUGH persona (should still
// hit the min floor), and assert the follow-up count lands in [min, max].
//
// Usage: node scripts/test_followups.mjs [baseUrl]

import OpenAI from 'openai';
import { readFileSync } from 'node:fs';

// Minimal .env loader (no dotenv dependency) — pull OPENAI_API_KEY if not already set.
if (!process.env.OPENAI_API_KEY) {
  try {
    for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
      const m = line.match(/^\s*OPENAI_API_KEY\s*=\s*(.+)\s*$/);
      if (m) process.env.OPENAI_API_KEY = m[1].replace(/^["']|["']$/g, '').trim();
    }
  } catch {}
}

const BASE = process.argv[2] || 'https://workflow-graph-40869618670.us-central1.run.app';
const openai = new OpenAI();

// ── Topic config (copied verbatim from BackgroundInterview.tsx) ───────────────
const TOPICS = [
  {
    field: 'responsibilities',
    text: 'What are your primary responsibilities at work?',
    maxFollowups: 2,
    minFollowups: 1,
    criteria: [
      "FLOOR — the participant has named at least one primary responsibility or area they own (e.g. 'I own the team's product specs', 'I'm responsible for patient care'). If they named NONE ('a bit of everything', 'various things'), follow up asking what they're mainly responsible for.",
      "BREADTH — if they named only ONE responsibility or area, follow up ONCE: briefly ACKNOWLEDGE it, then ask whether there are other areas they own or are accountable for. If they named several distinct responsibilities, breadth is covered.",
      "STAY AT OWNERSHIP ALTITUDE — this question maps WHAT they own, not how they spend their time. Do NOT drill into the specific tasks, activities, or day-to-day work under a responsibility — a later question ('a typical week') covers that. A responsibility named only at a high level is FINE here; do NOT treat missing task detail as uncovered.",
    ],
  },
  {
    field: 'typicalWeek',
    text: 'Walk me through a typical week. What are the recurring tasks you do?',
    maxFollowups: 3,
    minFollowups: 1,
    criteria: [
      "FLOOR — the participant has named at least one real recurring activity or task. If they named NO actual activity at all ('the usual', 'just work stuff', 'hard to say'), follow up asking what they regularly do in a typical week.",
      "BREADTH — if they named only ONE activity or area (e.g. 'mostly building an app', 'just seeing patients'), follow up ONCE: briefly ACKNOWLEDGE it, then ask whether there are other tasks or activities they also do regularly. Do NOT push for more detail on that one activity. If they named several distinct activities, breadth is covered.",
      "SUBSTANCE — the answer must give a concrete sense of WHAT the work actually is, not just generic activity labels. When a central activity is named only as a bare label (no topic, project, client, deliverable, audience, or tool), it is NOT covered — follow up: warmly pick the SINGLE most central still-vague activity and ask what it actually involves or is about. Probe ONE thread per turn. If the central activities already carry concrete substance, this is covered.",
      "RESPONSIBILITY COVERAGE — earlier in the conversation the participant described their primary responsibilities. If any responsibility or area they named does NOT clearly map to a task they mentioned, it is NOT fully covered: follow up ONCE, warmly, asking whether they regularly do anything on that responsibility. Probe ONE uncovered responsibility per turn.",
    ],
  },
  {
    field: 'outputs',
    text: 'What are the actual things you make or hand off at work — like reports, documents, code, or decisions?',
    maxFollowups: 3,
    minFollowups: 0,
    criteria: [
      "FLOOR — the participant has named at least one concrete output or artifact they own (e.g. 'the weekly sales report', 'patient charts', 'the onboarding deck'). If they named NONE ('not really anything', 'hard to say'), follow up warmly asking what they produce, maintain, or deliver.",
      "DECOMPOSITION — for each main output they named, the TASKS that go into creating or maintaining it should be reasonably clear. When an output is named as a bare noun with no sense of the work behind it, it is NOT covered — follow up ONCE: pick the SINGLE most central output and ask what goes into producing or maintaining it. Probe ONE output per turn. On later turns, if other central outputs are still bare nouns, you may decompose ONE more; stop once the work behind their main outputs is reasonably clear.",
      "BREADTH — if they named only ONE output, follow up ONCE: briefly ACKNOWLEDGE it, then ask whether there are other things they produce, maintain, or are accountable for. If they named several distinct outputs, breadth is covered.",
    ],
  },
  {
    field: 'stakeholders',
    text: 'Who do you do your work for or with — the people, teams, or clients you deal with?',
    maxFollowups: 3,
    minFollowups: 1,
    criteria: [
      "FLOOR — the participant has named at least one person, team, role, or outside party they do work for or with (e.g. 'my manager', 'the sales team', 'patients', 'external vendors'). If they named NONE ('I mostly work alone', 'no one really'), follow up warmly asking who they work for or with, even occasionally.",
      "BREADTH — surface the RANGE of people, not just one: if they named only their immediate team, follow up ONCE asking whether there are others they work for or with — people they depend on, people who depend on them, or anyone outside their team or organization (clients, customers, partners). If they named several distinct parties, breadth is covered.",
      "INTERACTION SUBSTANCE — for the main relationships, it should be clear WHAT the working relationship actually involves task-wise: what they do with or for that person or group (hand off to, coordinate with, report to, support, get input or feedback from). When a stakeholder is named only as a bare label with no sense of the actual exchange, follow up ONCE: warmly pick the SINGLE most central one and ask what they actually do with or for them. Probe ONE relationship per turn, never skeptically. If the main relationships already carry concrete substance, this is covered.",
    ],
  },
];

const PERSONAS = {
  vague: {
    blurb: 'a high school biology teacher. Answer briefly and a bit vaguely, in 1 short sentence, using generic labels and few specifics unless directly pushed. Never volunteer extra detail.',
    expectHigh: true,
  },
  thorough: {
    blurb: 'a high school biology teacher. Answer richly and specifically in 2-3 sentences, naming concrete tasks, topics, classes, and tools (e.g. grading lab reports on cell respiration, prepping the dissection unit, parent emails). Volunteer detail.',
    expectHigh: false,
  },
};

async function participantAnswer(personaBlurb, conversation, question) {
  const r = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.4,
    messages: [
      { role: 'system', content: `You are role-playing a participant in a work interview. You are ${personaBlurb} Answer the interviewer's question in first person. Output ONLY the answer text.` },
      { role: 'user', content: `${conversation ? conversation + '\n\n' : ''}Interviewer: ${question}\n\nYour answer:` },
    ],
  });
  return r.choices[0].message.content.trim();
}

async function evaluate(topic, combinedAnswer, followupCount, conversation) {
  const res = await fetch(`${BASE}/api/evaluate-answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: topic.text,
      answer: combinedAnswer,
      criteria: topic.criteria,
      maxFollowups: topic.maxFollowups,
      followupCount,
      minFollowups: topic.minFollowups,
      conversation,
      evaluationStyle: 'lenient',
    }),
  });
  if (!res.ok) throw new Error(`evaluate-answer ${res.status}: ${await res.text()}`);
  return res.json();
}

// Run one topic for one persona; returns the follow-up count and the Q/A log.
async function runTopic(topic, persona, priorConvo) {
  const convo = [...priorConvo];
  const log = [];
  // Initial answer to the canonical question.
  let answer = await participantAnswer(persona.blurb, convo.map(t => `Interviewer: ${t.q}\nParticipant: ${t.a}`).join('\n'), topic.text);
  convo.push({ q: topic.text, a: answer });
  log.push({ q: topic.text, a: answer, follow: false });
  let combined = answer;
  let followUpCount = 0;

  // Loop mirrors BackgroundInterview.advance(): evaluate while capacity remains.
  while (followUpCount < topic.maxFollowups) {
    const conversation = convo.map(t => `Interviewer: ${t.q}\nParticipant: ${t.a}`).join('\n');
    const result = await evaluate(topic, combined, followUpCount, conversation);
    if (result.allCovered || !result.followUp) break;
    followUpCount += 1;
    const ans = await participantAnswer(persona.blurb, conversation, result.followUp);
    convo.push({ q: result.followUp, a: ans });
    log.push({ q: result.followUp, a: ans, follow: true });
    combined = `${combined}\n${ans}`;
  }
  return { followUpCount, log, convo };
}

async function main() {
  let allPass = true;
  for (const [pname, persona] of Object.entries(PERSONAS)) {
    console.log(`\n${'='.repeat(72)}\nPERSONA: ${pname} — ${persona.expectHigh ? 'expect follow-ups toward MAX' : 'expect follow-ups at MIN floor'}`);
    let priorConvo = [];
    for (const topic of TOPICS) {
      const { followUpCount, log, convo } = await runTopic(topic, persona, priorConvo);
      priorConvo = convo; // tasks question sees the responsibilities answers
      const ok = followUpCount >= topic.minFollowups && followUpCount <= topic.maxFollowups;
      allPass = allPass && ok;
      console.log(`\n  ── ${topic.field}  [min ${topic.minFollowups}, max ${topic.maxFollowups}] → ${followUpCount} follow-up(s)  ${ok ? 'PASS' : 'FAIL'}`);
      for (const t of log) {
        console.log(`     ${t.follow ? '↳ FOLLOW-UP' : 'Q'}: ${t.q}`);
        console.log(`        A: ${t.a.replace(/\n/g, ' ')}`);
      }
    }
  }
  console.log(`\n${'='.repeat(72)}\n${allPass ? 'ALL PASS' : 'SOME FAILED'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
