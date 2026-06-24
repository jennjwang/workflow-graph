// Analyst-perspective quality metric. An LLM judge scores every task statement
// in each inventory against the rubric (validation/rubric.json); we report the
// per-criterion pass rate per method with Wilson CIs, and an overall "all-pass"
// rate. Later: validate the judge against an analyst-rated subset.
//
// Usage: node --env-file=.env validation/quality.mjs
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import { loadInventories } from './lib/io.mjs';
import { wilsonCI } from './lib/stats.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.QUALITY_MODEL || 'gpt-4o';
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const CONCURRENCY = 8;

async function loadRubric() {
  return JSON.parse(await fs.readFile(path.join(__dirname, 'rubric.json'), 'utf-8'));
}

async function judge(statement, occupation, rubric) {
  const criteria = rubric.criteria
    .map((c) => `- ${c.key}: ${c.question}`)
    .join('\n');
  const sys =
    `You are an occupational analyst reviewing task statements for the occupation "${occupation}". ` +
    `For the given task statement, judge each criterion as true (passes) or false (fails). ` +
    `Be a strict reviewer. Respond ONLY with JSON: an object whose keys are the criterion keys, ` +
    `each mapping to {"pass": boolean, "reason": short string}.\n\nCriteria:\n${criteria}`;
  const res = await client.chat.completions.create({
    model: MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: `Task statement: "${statement}"` },
    ],
  });
  return JSON.parse(res.choices[0].message.content);
}

async function mapLimit(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}

async function main() {
  const inv = await loadInventories();
  const rubric = await loadRubric();
  const keys = rubric.criteria.map((c) => c.key);
  const outDir = path.join(__dirname, 'out', 'quality');
  await fs.mkdir(outDir, { recursive: true });

  const summary = {};
  for (const [method, entry] of Object.entries(inv.methods)) {
    const stmts = entry.statements;
    process.stderr.write(`judging ${method} (${stmts.length} statements)…\n`);
    const graded = await mapLimit(stmts, CONCURRENCY, async (s) => {
      const r = await judge(s, inv.occupation, rubric);
      return { statement: s, scores: Object.fromEntries(keys.map((k) => [k, !!(r[k] && r[k].pass)])),
               reasons: Object.fromEntries(keys.map((k) => [k, r[k] && r[k].reason])) };
    });
    await fs.writeFile(path.join(outDir, `${method}.json`), JSON.stringify(graded, null, 2));
    const n = graded.length;
    const perCrit = {};
    for (const k of keys) {
      const pass = graded.filter((g) => g.scores[k]).length;
      perCrit[k] = { pass, n, ...wilsonCI(pass, n) };
    }
    const allPass = graded.filter((g) => keys.every((k) => g.scores[k])).length;
    summary[method] = { n, perCrit, allPass, allPassCI: wilsonCI(allPass, n) };
  }

  // Report
  const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : '—');
  console.log(`\nAnalyst-rubric quality (judge: ${MODEL})\n`);
  const methods = Object.keys(summary);
  const head = ['criterion'.padEnd(22), ...methods.map((m) => `${m} (n=${summary[m].n})`.padEnd(18))].join('');
  console.log(head);
  console.log('-'.repeat(head.length));
  for (const c of rubric.criteria) {
    const cells = methods.map((m) => {
      const r = summary[m].perCrit[c.key];
      return `${pct(r.p)} [${pct(r.lo)},${pct(r.hi)}]`.padEnd(18);
    });
    console.log(c.label.padEnd(22) + cells.join(''));
  }
  const allCells = methods.map((m) => `${pct(summary[m].allPassCI.p)} [${pct(summary[m].allPassCI.lo)},${pct(summary[m].allPassCI.hi)}]`.padEnd(18));
  console.log('ALL criteria pass'.padEnd(22) + allCells.join(''));
}

main().catch((err) => { console.error(err); process.exit(1); });
