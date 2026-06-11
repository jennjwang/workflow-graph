// Simulate full background-interview conversations for testing.
//
//   node --env-file=.env scripts/sim_interview.mjs
//   node --env-file=.env scripts/sim_interview.mjs "Concrete ER nurse"   # one persona
//
// An LLM plays a participant persona; the real /api/evaluate-answer endpoint
// drives the coverage judgment + follow-ups, exactly like the live app
// (including the prior-follow-ups guard so it never re-probes the same thread).

import OpenAI from "openai";

const API = process.env.SIM_API || "http://localhost:3001";
const PARTICIPANT_MODEL = process.env.SIM_PARTICIPANT_MODEL || "gpt-4o-mini";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const only = process.argv[2]; // optional persona-name filter

// Mirror of the live QUESTIONS (canonical text + criteria + caps).
const QUESTIONS = [
  {
    field: "jobTitle",
    text: "To start, what is your current role, and how long have you been in this job?",
    evaluationStyle: "lenient",
    maxFollowups: 1,
    criteria: [
      "Named their job title or role. Any brief mention is sufficient.",
      "It is clear what field or industry they work in.",
      "Indicated roughly how long they've been in this role — a rough range is enough, and a tenure cue embedded in the role ('first-year PhD', 'new grad') also satisfies this. Do NOT re-ask duration once present.",
    ],
  },
  {
    field: "responsibilities",
    text: "What are your primary responsibilities at work?",
    evaluationStyle: "lenient",
    maxFollowups: 2,
    criteria: [
      "FLOOR — named at least one primary responsibility or area they own. If they named NONE ('a bit of everything', 'various things'), follow up asking what they're mainly responsible for.",
      "TASKS UNDER RESPONSIBILITIES — when they've named responsibilities/areas at a high level but NOT the concrete tasks those involve, it's NOT fully covered: pick ONE responsibility they named and ask what specific tasks or activities fall under it (e.g. 'I'm responsible for the backend' → 'When it comes to the backend, what are the main things you actually do?'). On a later turn, if OTHER responsibilities are still high-level areas, drill into ONE more. Stop once the tasks under their main responsibilities are reasonably clear. If they already described the concrete tasks, covered. Probe ONE responsibility per turn, warmly, never skeptically.",
    ],
  },
  {
    field: "typicalWeek",
    text: "Think back over this past week — what did you actually work on?",
    evaluationStyle: "lenient",
    maxFollowups: 3,
    criteria: [
      "FLOOR — named at least one real activity; if none ('the usual'), follow up asking what they worked on.",
      "BREADTH — if only ONE activity named, acknowledge then ask what else; several distinct = covered.",
      "SUBSTANCE — the answer must give a concrete sense of WHAT the work is, not just generic labels. When a central activity is named only as a bare label (no topic/project/client/deliverable/tool), NOT covered — warmly pick the SINGLE most central still-vague activity and ask what it's about. Probe ONE thread per turn, never skeptical. On later turns, if other central activities are STILL bare labels, you may probe ONE more; stop once the main parts of the week are reasonably concrete. If central activities already carry substance, covered.",
      "RESPONSIBILITY COVERAGE — the EARLIER context lists the responsibilities they named. If any responsibility there does NOT clearly map to a task they mentioned this week, NOT covered: warmly ask whether they did anything on that responsibility this week. Probe ONE uncovered responsibility per turn. If no earlier context or every responsibility maps to something mentioned, covered.",
      "Representativeness — only if they signal the week was atypical, ask what a normal week looks like.",
    ],
  },
];

const PERSONAS = [
  {
    name: "Vague founder",
    brief:
      "You are an early-stage startup founder. You answer briefly and in generic labels — 'I have some zooms and a standup, I go to networking events, otherwise I write proposals and do research.' You don't volunteer specifics unless directly asked, and even then you stay fairly high-level.",
  },
  {
    name: "Concrete ER nurse",
    brief:
      "You are a second-year ER nurse. You answer naturally with concrete specifics — actual tasks, patients, tools, handoffs.",
  },
  {
    name: "Terse engineer",
    brief:
      "You are a backend software engineer, ~4 years in. Very short answers, have to be drawn out. First answers are one-liners like 'fixing bugs' or 'the usual sprint stuff.'",
  },
  {
    name: "Rambling over-explainer",
    brief:
      "You are a marketing manager at a mid-size B2B SaaS company, ~6 years in. You OVER-explain — long, winding answers full of tangents, backstory, and feelings, but often light on concrete specifics. You bury the actual tasks inside a lot of words.",
  },
  {
    name: "One-word answerer",
    brief:
      "You are a warehouse associate. You answer in one to three words and almost never elaborate unless pushed hard. E.g. 'picking', 'boxes', 'the usual'. Stay in character — minimal words.",
  },
  {
    name: "Non-native speaker",
    brief:
      "You are a line cook at a busy restaurant, English is your second language. You answer with simple words and some grammatical quirks (dropped articles, present tense), but you ARE concrete about the actual work — prepping, stations, dishes.",
  },
  {
    name: "Technical officer at O*NET",
    brief:
      "You are a senior technical officer at O*NET, the organization that maintains the U.S. occupational database, about 8 years in. Your work mixes data and coordination: maintaining and updating occupational data, reviewing data quality, coordinating with analysts and outside contractors, and writing technical documentation. You answer in a measured, somewhat formal way and TEND TO STAY HIGH-LEVEL at first ('I oversee data operations', 'I'm responsible for the database') before giving concrete specifics only if asked.",
  },
  {
    name: "Elementary teacher",
    brief:
      "You are a 3rd-grade teacher, 5 years in. Concrete and down-to-earth about classroom work — lesson plans, grading, parent emails, recess duty — but modest and brief; you don't think of your work as impressive.",
  },
  {
    name: "Freelance designer",
    brief:
      "You are a freelance graphic designer, ~7 years. You juggle several clients and describe work in vague chunks ('client work', 'some branding stuff') without naming who or what unless asked.",
  },
  {
    name: "Construction electrician",
    brief:
      "You are a journeyman electrician on commercial job sites, 10 years. Practical, plain-spoken, fairly terse — you talk about wiring, panels, inspections, but don't elaborate much.",
  },
  {
    name: "Accountant",
    brief:
      "You are a staff accountant at a mid-size firm, 3 years. Routine, structured work — reconciliations, journal entries, month-end close, client returns. You answer matter-of-factly and briefly.",
  },
  {
    name: "Retail store manager",
    brief:
      "You manage a clothing retail store, 4 years. Your work is half people, half operations — scheduling, inventory, coaching staff, handling customers. You answer briefly and tend to say 'a bit of everything' before specifics.",
  },
  {
    name: "Customer support rep",
    brief:
      "You are a customer support rep at a software company, 2 years. You answer tickets, hop on calls, escalate bugs. You describe it generically ('helping customers', 'answering tickets') and stay brief.",
  },
  {
    name: "AI-heavy data scientist",
    brief:
      "You are a data scientist, 4 years, who leans heavily on AI tools (Copilot, ChatGPT) for code, analysis, and writing. Concrete but brief — models, dashboards, experiments — and you naturally mention using AI for parts of it.",
  },
  {
    name: "Social worker",
    brief:
      "You are a child & family social worker, 6 years. Heavy caseload — home visits, case notes, court reports, coordinating services. You answer briefly and a bit guardedly, keeping client specifics vague.",
  },
];

async function participant(persona, question, history) {
  const res = await client.chat.completions.create({
    model: PARTICIPANT_MODEL,
    temperature: 0.85,
    messages: [
      {
        role: "system",
        content: `${persona.brief}\n\nYou are being interviewed about your work. Answer in first person, in character, like a real person typing in a chat — natural, no narration.\n\nIMPORTANT — be realistic: real people don't volunteer much in interviews. Keep answers SHORT — usually one sentence, occasionally two. Don't over-explain, don't enumerate everything you can think of, don't add backstory or feelings. Just say the first thing that comes to mind and stop. (Only give long, winding answers if your persona is explicitly a rambling over-explainer.) Stay consistent with what you've already said.\n\nOutput ONLY your reply text — no speaker label or prefix like "Me:".`,
      },
      {
        role: "user",
        content: `Conversation so far:\n${history.length ? history.join("\n") : "(none yet)"}\n\nInterviewer: ${question}\n\nYour answer:`,
      },
    ],
  });
  return res.choices[0].message.content.trim();
}

async function evaluate(q, answer, followupCount, conversation) {
  const res = await fetch(`${API}/api/evaluate-answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: q.text,
      answer,
      criteria: q.criteria,
      maxFollowups: q.maxFollowups,
      followupCount,
      evaluationStyle: q.evaluationStyle,
      conversation,
    }),
  });
  return res.json();
}

async function runInterview(persona) {
  console.log(`\n${"═".repeat(74)}\n  PERSONA: ${persona.name}\n${"═".repeat(74)}`);
  const history = [];
  for (const q of QUESTIONS) {
    console.log(`\n  🧑‍💼 ${q.text}`);
    let answer = await participant(persona, q.text, history);
    console.log(`  🙂 ${answer}`);
    history.push(`Interviewer: ${q.text}`, `Participant: ${answer}`);

    let accumulated = answer;
    let asked = 0;
    while (asked < q.maxFollowups) {
      const ev = await evaluate(q, accumulated, asked, history.join("\n"));
      if (ev.allCovered || !ev.followUp) break;
      console.log(`     ↳ ${ev.followUp}`);
      asked++;
      const fa = await participant(persona, ev.followUp, history);
      console.log(`  🙂 ${fa}`);
      history.push(`Interviewer: ${ev.followUp}`, `Participant: ${fa}`);
      accumulated += `\n${fa}`;
    }
  }
}

for (const persona of PERSONAS) {
  if (only && persona.name !== only) continue;
  await runInterview(persona);
}
console.log();
