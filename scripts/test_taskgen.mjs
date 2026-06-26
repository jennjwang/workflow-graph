// Replay real sessions through /api/generate-tasks-from-interview and print the
// resulting task list, separating validated (source:interview) from inferred
// gap-fill (source:gap). For eyeballing wording specificity + gap-fill quality.
//   node scripts/test_taskgen.mjs [sessionPrefix ...]
import { readFileSync, readdirSync, statSync } from 'node:fs';

const API = process.env.SIM_API || 'http://localhost:3001';
const DIR = new URL('../sessions/', import.meta.url);

function pick() {
  const args = process.argv.slice(2);
  const all = readdirSync(DIR).filter((f) => f.endsWith('.json'));
  if (args.length) return args.map((a) => all.find((f) => f.startsWith(a))).filter(Boolean);
  return all.map((f) => ({ f, m: statSync(new URL(f, DIR)).mtimeMs })).sort((a, b) => b.m - a.m)
    .filter((x) => (JSON.parse(readFileSync(new URL(x.f, DIR))).interviewExtractedTasks || []).length >= 6)
    .slice(0, 3).map((x) => x.f);
}

async function gen(file) {
  const s = JSON.parse(readFileSync(new URL(file, DIR)));
  const p = s.userProfile || {};
  const body = { jobTitle: p.jobTitle, typicalWeek: p.typicalWeek, responsibilities: p.responsibilities, interviewTasks: s.interviewExtractedTasks || [] };
  const res = await fetch(`${API}/api/generate-tasks-from-interview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const txt = await res.text();
  const interview = [], gap = [];
  for (const block of txt.split('\n\n')) {
    const ev = block.match(/event: (\w+)/), dt = block.match(/data: (.+)/);
    if (ev && ev[1] === 'task' && dt) { const o = JSON.parse(dt[1]); (o.source === 'gap' ? gap : interview).push(o.name); }
  }
  console.log(`\n${'='.repeat(78)}\n${p.jobTitle}  (mentioned ${body.interviewTasks.length})\n${'='.repeat(78)}`);
  console.log(`-- VALIDATED (${interview.length}) --`); interview.forEach((t) => console.log('  • ' + t));
  console.log(`-- GAP-FILL (${gap.length}) --`); gap.forEach((t) => console.log('  + ' + t));
}

for (const f of pick()) await gen(f);
