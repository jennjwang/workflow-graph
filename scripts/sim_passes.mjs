// End-to-end simulation of the full multi-pass interview, using REAL participant
// profiles (from /Users/jenniferwang/PhD/task_aggregation/data) as ground-truth
// personas. Faithfully mirrors BackgroundInterview.tsx: for each pass it rewords
// the question (/api/interview-question, with context for contextual passes),
// role-plays the participant's answer, runs the follow-up loop
// (/api/evaluate-answer, honoring skipRequested + min/max), and — for auto-skip
// passes — first asks /api/check-coverage whether the pass is even worth raising.
//
// Usage: node scripts/sim_passes.mjs [baseUrl]   (default localhost:3001)

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
const DATA = '/Users/jenniferwang/PhD/task_aggregation/data';
const openai = new OpenAI();

// Real profiles to simulate (diverse roles).
const PROFILE_IDS = [
  '6d62d958-9b70-4d7e-8ac1-a96cb7c79fc0', // Software developer (the reviewed one)
  'b52f3058-3455-4130-ae04-36524941936b', // Lawyer
  'fa924cb3-3283-49b9-a59c-6fa0b946c2b3', // Postdoc, Econ + CS
];

function loadPersona(id) {
  const d = JSON.parse(readFileSync(`${DATA}/${id}.json`, 'utf8'));
  const up = d.userProfile || {};
  let tasks = [];
  try {
    const p = JSON.parse(readFileSync(`${DATA}/profiles/${id}.json`, 'utf8'));
    tasks = (p.background_tasks || []).slice(0, 18);
  } catch {}
  // Verbatim participant answers from the real interview — used as STYLE
  // exemplars so the simulated participant writes the way this person actually
  // wrote (length, tone, punctuation, grammar quirks), not generic LLM prose.
  const styleSamples = (d.backgroundTranscript || [])
    .map((t) => (t.answer || '').trim())
    .filter((a) => a.length > 12)
    .slice(0, 6);
  return {
    id,
    jobTitle: (up.jobTitle || '').trim(),
    responsibilities: (up.responsibilities || '').trim(),
    typicalWeek: (up.typicalWeek || '').trim(),
    tasks,
    styleSamples,
  };
}

// ── Pass config — copied from BackgroundInterview.tsx QUESTIONS ──────────────
const PASSES = [
  { field: 'jobTitle', autoSkip: false, staticText: true, maxFollowups: 1, minFollowups: 0,
    text: 'To start, what is your current role, and how long have you been in this job?',
    framingNotes: '', criteria: [
      'The participant has named their job title or role. Any brief mention is sufficient.',
      'It is clear what field or industry the participant works in.',
      'They indicated roughly how long they have been in this role (a rough range is fine; a tenure cue in how they describe the role also counts). Do NOT re-probe duration.',
    ] },
  { field: 'responsibilities', autoSkip: false, maxFollowups: 2, minFollowups: 0,
    text: 'What are your primary responsibilities at work?',
    framingNotes: "Ask what their main responsibilities are — the parts of the job they're responsible for, NOT the day-to-day activities (that's a later question). Keep the word 'responsibilities'. Use plain wording that fits ANY job; do NOT use managerial verbs unless they did.",
    criteria: [
      "FLOOR — named at least one primary responsibility or area they own. If NONE ('a bit of everything'), follow up asking what they're mainly responsible for.",
      'STAY AT OWNERSHIP ALTITUDE — map WHAT they own, not how they spend their time. Do NOT drill into tasks under a responsibility (a later question covers that). Do NOT ask whether there are OTHER areas they are responsible for.',
    ] },
  { field: 'typicalWeek', autoSkip: true, maxFollowups: 4, minFollowups: 2,
    text: 'Walk me through a typical week. What are the recurring tasks you do?',
    framingNotes: "Ask them to walk through a typical week and name the recurring tasks they regularly do. Frame around what's TYPICAL and RECURRING. Encourage specificity about the actual tasks.",
    criteria: [
      "FLOOR — named at least one real recurring activity/task. If none, follow up asking what they regularly do.",
      'BREADTH — if they named only ONE activity, acknowledge it then ask whether there are other tasks they also do regularly. If several, covered.',
      'SUBSTANCE — give the TASKS the work involves. If a central activity is a bare label, ask what they have to DO for it (the smaller tasks it breaks into) — NOT its topic. Probe ONE thread per turn.',
      "DEEPEN THE CENTER — if ONE activity DOMINATES their week (e.g. a developer who mostly programs), drill into the DISTINCT KINDS of work within that core activity before broadening (e.g. 'what are the different kinds of programming work that come up?' → building, debugging, testing, refactoring). KINDS of work = tasks, not content. Only once the core is richly covered, rotate to smaller activities. If no activity dominates or the core is detailed, covered.",
      'RESPONSIBILITY COVERAGE — if a responsibility they named earlier does not map to a task they mentioned, follow up ONCE asking whether they regularly do anything on it. Probe ONE per turn.',
    ] },
  { field: 'outputs', autoSkip: true, contextual: true, maxFollowups: 2, minFollowups: 0,
    text: 'What do you produce or deliver in your work — like reports, documents, code, or designs?',
    framingNotes: "Outputs — tangible things they produce/update/approve/send/maintain/deliver. Phrase it SPECIFICALLY and NATURALLY for THIS participant's role with a couple of fitting example artifacts (e.g. developer 'what do you ship?', lawyer 'what do you draft or file?'), WITHOUT naming specific things they haven't mentioned. Do NOT use 'actually' or a generic noun list or odd examples like 'a decision'.",
    criteria: [
      "FLOOR — named at least one concrete output/artifact. If NONE, follow up asking what they produce/maintain/deliver.",
      "DELIVERY & UPKEEP (not building) — a typical-week question already covers how they DO the work, so do NOT re-ask how they build an output. Focus on FINISHING/DELIVERY: what they do to get it READY and OUT or keep it up to date — checking, formatting, approval, sending, maintenance (e.g. 'code' → 'once it's written, what do you do to get it ready to hand off?'). If that's clear or would just repeat the building, covered.",
      'BREADTH — if only ONE output, acknowledge then ask whether there are other things they produce. If several, covered.',
    ] },
  { field: 'stakeholders', autoSkip: true, contextual: true, maxFollowups: 1, minFollowups: 0,
    text: 'Who do you do your work for or with — the people, teams, or clients you deal with?',
    framingNotes: "GOAL: surface the participant's RELATIONAL / COMMUNICATION tasks — interpersonal work involving others (meetings, status updates, reporting, coordinating handoffs, giving/getting feedback, reviewing others' work, escalating, mentoring, presenting). WHO is just the entry point; the aim is the TASKS those relationships carry. Phrase SPECIFICALLY for THIS role, WITHOUT naming specific people they haven't mentioned.",
    criteria: [
      "FLOOR — named at least one person/team/role/outside party they work for or with. If NONE, follow up asking who they work for or with.",
      "RELATIONAL TASKS (PRIORITIZE) — surface the COMMUNICATION/INTERPERSONAL tasks each main relationship carries (what they communicate, coordinate, hand off, report, review, escalate, give/get feedback on). If a stakeholder is a bare label, follow up ONCE asking what they actually do with/for the most central one — use a CLEAR, plain question — e.g. 'How do you usually interact with them?', 'What do you usually go to them for, or do for them?', 'What do you usually work on with them?'. Avoid clunky phrasings like 'back-and-forth'. Aim to draw out relational tasks (running the sync, writing the update, reviewing PRs) without leading. Probe ONE per turn.",
      'BREADTH (secondary) — only if they named ONE party and others clearly exist. Do NOT reflexively ask "who else".',
    ] },
  { field: 'tools', autoSkip: true, maxFollowups: 3, minFollowups: 0,
    text: 'What tools or systems do you use at work, and have any of them changed how you work?',
    framingNotes: 'Tools/systems they use AND especially how those tools have CHANGED the way they work (new tasks a tool created, steps automated away, a different process). Concrete; a couple of examples ok, not a checklist.',
    criteria: [
      "FLOOR — named at least one tool/system/equipment, OR indicated they don't really use notable tools. A 'no'/'not really'/'I don't focus on specific tools' is a COMPLETE valid answer — accept and move on, do NOT re-ask in another form. Only if tools weren't addressed at all may you ask ONCE; if they then decline, covered.",
      "WORKFLOW CHANGE — ONLY if they named tools: surface HOW a tool changed what they do. If they don't use notable tools or already described an effect, covered — do NOT push.",
      'USE SUBSTANCE — ONLY if they named tools as bare labels: follow up ONCE. If they declined or it is concrete, covered.',
    ] },
  { field: 'invisibleWork', autoSkip: true, staticText: true, maxFollowups: 2, minFollowups: 0,
    text: 'Is there any behind-the-scenes work you do that tends to go unnoticed — that people would only notice if it stopped?',
    framingNotes: 'Invisible/under-recognized work (maintenance, checking, coordinating, cleanup, preventing problems, glue work). Reflective, low-pressure; a simple "no" is a fine answer; do NOT pressure or supply a list.',
    criteria: [
      "FLOOR — a 'no'/'nothing comes to mind'/'not really' is a COMPLETE valid answer: accept and move on, do NOT push. Only if they gestured at something abstract may you follow up ONCE gently. Never pressure.",
      'SUBSTANCE — if they named invisible work only as a vague label, follow up ONCE asking what they concretely do. If they declined or it is concrete, covered.',
    ] },
];
const FINAL_CATCHALL = "Last one: if someone shadowed you for two weeks, what tasks would they see that we haven't named yet?";

// ── Endpoints ────────────────────────────────────────────────────────────────
async function reword(canonicalQuestion, framingNotes, context) {
  const r = await fetch(`${BASE}/api/interview-question`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ canonicalQuestion, framingNotes, context: context || '' }) });
  const j = await r.json();
  return j.question || canonicalQuestion;
}
async function evaluate(p, combined, fc, conversation) {
  const r = await fetch(`${BASE}/api/evaluate-answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: p.text, answer: combined, criteria: p.criteria, maxFollowups: p.maxFollowups, followupCount: fc, evaluationStyle: 'lenient', conversation, minFollowups: p.minFollowups }) });
  return r.json();
}
async function checkCoverage(p, conversation) {
  const r = await fetch(`${BASE}/api/check-coverage`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: p.text, criteria: p.criteria, conversation }) });
  return r.json();
}

// ── Simulated participant ────────────────────────────────────────────────────
function personaSystem(persona) {
  const styleBlock = persona.styleSamples.length
    ? `\n\nHOW YOU WRITE — these are YOUR OWN actual answers from earlier. Match this style CLOSELY: the same length and level of detail, tone, punctuation (or lack of it), capitalization, sentence structure, and grammar quirks or typos. Do NOT clean it up, do NOT make it more polished, articulate, or longer than this. If these ramble, you ramble; if they're terse and comma-light, be terse and comma-light. Apply this to EVERY answer including follow-ups and elaborations, and do NOT use bullet lists or markdown formatting unless these samples do:\n"""\n${persona.styleSamples.join('\n---\n')}\n"""`
    : '';
  return `You are role-playing a participant in a short interview about your work. This is the GROUND TRUTH about you — answer ONLY consistently with it, never invent a different job:
ROLE: ${persona.jobTitle}
RESPONSIBILITIES: ${persona.responsibilities}
TYPICAL WEEK: ${persona.typicalWeek}
${persona.tasks.length ? `TASKS YOU'RE KNOWN TO DO: ${persona.tasks.join('; ')}` : ''}${styleBlock}

Answer the interviewer's question in first person, writing in YOUR style as shown above. Don't dump everything at once — answer what's asked, at the length and detail level you'd naturally give. If a question genuinely doesn't apply to you, it's fine to say so briefly ("not really" / "no"). Output ONLY the answer text.`;
}
async function participantAnswer(persona, conversation, question) {
  const r = await openai.chat.completions.create({ model: 'gpt-4o-mini', temperature: 0.5,
    messages: [{ role: 'system', content: personaSystem(persona) },
      { role: 'user', content: `${conversation ? conversation + '\n\n' : ''}Interviewer: ${question}\n\n(Write this answer in YOUR style from the samples — same rough length, punctuation/capitalization habits, and informality. This applies to EVERY answer, including follow-ups: do NOT become more polished, articulate, structured, or longer than your samples just because you're elaborating. Do NOT use bullet lists or markdown unless your samples did.)\n\nYour answer:` }] });
  // Occasionally the model echoes a "Participant:"/"You:" speaker prefix — strip it.
  return r.choices[0].message.content.trim().replace(/^\s*(participant|you|me|a)\s*:\s*/i, '').trim();
}

const convoText = (convo) => convo.map((t) => `Interviewer: ${t.q}\nParticipant: ${t.a}`).join('\n');

async function runPersona(persona) {
  console.log(`\n${'#'.repeat(78)}\n# ${persona.jobTitle.replace(/\n/g, ' ').slice(0, 72)}\n# (${persona.id.slice(0, 8)})\n${'#'.repeat(78)}`);
  const convo = [];
  for (const p of PASSES) {
    // Auto-skip: is this pass worth raising given everything said so far?
    if (p.autoSkip && convo.length) {
      const cov = await checkCoverage(p, convoText(convo));
      if (cov.covered) {
        console.log(`\n[${p.field}]  ⏭  AUTO-SKIPPED — ${cov.reason}`);
        continue;
      }
    }
    const context = p.contextual ? convoText(convo) : '';
    const q = p.staticText ? p.text : await reword(p.text, p.framingNotes, context);
    let a = await participantAnswer(persona, convoText(convo), q);
    convo.push({ q, a });
    console.log(`\n[${p.field}]\n  Q: ${q}\n     A: ${a}`);
    let combined = a, fc = 0;
    while (fc < p.maxFollowups) {
      const res = await evaluate(p, combined, fc, convoText(convo));
      if (res.skipRequested) { console.log('     · (participant skipped)'); break; }
      if (res.allCovered || !res.followUp) break;
      fc++;
      const fa = await participantAnswer(persona, convoText(convo), res.followUp);
      convo.push({ q: res.followUp, a: fa });
      combined += `\n${fa}`;
      console.log(`  ↳ ${res.followUp}\n     A: ${fa}`);
    }
  }
  // Final catch-all (verbatim).
  const ca = await participantAnswer(persona, convoText(convo), FINAL_CATCHALL);
  convo.push({ q: FINAL_CATCHALL, a: ca });
  console.log(`\n[catch-all]\n  Q: ${FINAL_CATCHALL}\n     A: ${ca}`);
}

for (const id of PROFILE_IDS) {
  try {
    await runPersona(loadPersona(id));
  } catch (e) {
    console.error(`\n[${id.slice(0, 8)}] FAILED:`, e.message);
  }
}
console.log('\nDONE');
