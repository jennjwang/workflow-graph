// Show sample reworded variants for each interview pass, via the live
// /api/interview-question endpoint (the same rephraser the app uses).
// Usage: node scripts/sample_questions.mjs [baseUrl]   (default localhost:3001)

const BASE = process.argv[2] || 'http://localhost:3001';

// jobTitle is shown VERBATIM (no rephrasing on question 0); the final catch-all
// is also shown verbatim. Everything between is reworded per session.
const VERBATIM = {
  jobTitle: 'To start, what is your current role, and how long have you been in this job?',
  finalCatchall: "Last one: if someone shadowed you for two weeks, what tasks would they see that we haven't named yet?",
};

const PASSES = [
  {
    field: 'responsibilities',
    text: 'What are your primary responsibilities at work?',
    framingNotes:
      "Ask what their main responsibilities are — the parts of the job they're responsible for, NOT the day-to-day activities (that's a later question). Keep the word 'responsibilities'; do NOT swap in 'duties', 'tasks', or 'key areas'. Use plain wording that fits ANY job; do NOT use managerial verbs like 'oversee', 'manage', 'lead', or 'in charge of'.",
  },
  {
    field: 'typicalWeek',
    text: 'Walk me through a typical week. What are the recurring tasks you do?',
    framingNotes:
      "Ask them to walk through a typical week and name the recurring tasks they regularly do. Frame around what's TYPICAL and RECURRING — the things they do on a regular basis — NOT a specific recent week. You MAY invite them to walk through it loosely, but do NOT force a rigid hour-by-hour or day-by-day breakdown. KEEP the encouragement to be as specific as possible about the actual tasks they do.",
  },
  {
    field: 'outputs',
    text: 'What are the actual things you make or hand off at work — like reports, documents, code, or decisions?',
    framingNotes:
      "Elicit tasks via the participant's OUTPUTS — the tangible things they make, update, approve, send, maintain, or deliver, and anything with their name attached. Keep it CONCRETE and grounded: anchor the question in two or three real example artifacts (e.g. reports, documents, dashboards, code, decks, tickets, cases, decisions) so it lands as 'what's the actual stuff you produce' rather than an abstract list of verbs. Pick just a couple of examples — do NOT read the whole list as a checklist, and do NOT make it sound like an HR form. The point is to surface tangible things they'd skip when narrating activities, then decompose each output into the work behind it.",
  },
  {
    field: 'stakeholders',
    text: 'Who do you do your work for or with — the people, teams, or clients you deal with?',
    framingNotes:
      "Elicit tasks via the participant's STAKEHOLDERS — the people, teams, roles, clients, or outside parties they do work FOR or WITH. Draw on the social side of work: who they depend on and who depends on them (handoffs both ways), who they coordinate or communicate with, who they report to or support, and anyone OUTSIDE their team or organization (clients, customers, partners, the public). Keep it warm and concrete; you MAY name a couple of example relationships to prompt them, but do NOT read a checklist. The point is to surface interactions that carry tasks — meetings, handoffs, coordinating, reporting, supporting — that they'd skip when narrating solo activities, then draw out what they actually do with or for each.",
  },
  {
    field: 'tools',
    text: 'What systems or tools do you use for work — and do any of them create tasks for you?',
    framingNotes:
      "Elicit tasks via the TOOLS and SYSTEMS the participant uses — the software, platforms, equipment, or systems that are part of their work, and ESPECIALLY the ones that GENERATE work for them (a ticket or case queue, an inbox, alerts or notifications, a dashboard that flags issues, an EHR worklist, a CRM, a calendar). Keep it warm and concrete; you MAY offer a couple of examples that fit any job, but do NOT read a checklist. The point is to surface tool-driven tasks — responding to tickets, clearing a queue, acting on alerts, updating records in a system — that they'd skip when narrating activities, then draw out what they actually do in each tool.",
  },
  {
    field: 'invisibleWork',
    text: 'What would people only notice if you stopped doing it?',
    framingNotes:
      "Elicit the INVISIBLE or under-recognized work — the necessary background tasks that keep things running but go unnoticed until they STOP: maintenance, checking and monitoring, coordinating, cleanup, chasing loose ends, preventing problems before they happen, the 'glue' work, the quiet emotional labor. This is a reflective question, so keep it warm and low-pressure and give them room to think; you MAY offer one gentle example, but do NOT supply a list. The point is to surface real tasks that don't show up when people narrate their visible deliverables and activities.",
  },
];

async function reword(canonicalQuestion, framingNotes) {
  const r = await fetch(`${BASE}/api/interview-question`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ canonicalQuestion, framingNotes }),
  });
  const j = await r.json();
  return j.question;
}

console.log(`\n0. jobTitle  (shown VERBATIM — no rephrasing)\n   ${VERBATIM.jobTitle}\n`);
let n = 1;
for (const p of PASSES) {
  console.log(`${n}. ${p.field}`);
  console.log(`   canonical: ${p.text}`);
  for (let i = 0; i < 2; i++) {
    const q = await reword(p.text, p.framingNotes);
    console.log(`   variant ${i + 1}: ${q}`);
  }
  console.log('');
  n++;
}
console.log(`${n}. final catch-all  (shown VERBATIM)\n   ${VERBATIM.finalCatchall}\n`);
