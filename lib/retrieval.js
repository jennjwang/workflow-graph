// Retrieval grounding for the upper-level task generator.
//
// Strategy (no embeddings, no vector DB): the corpus is ~20k task statements
// grouped by occupation. At generation time we make ONE LLM call to pick the
// best-matching occupation(s) from the corpus's occupation list, then do a
// plain in-memory lookup of that occupation's statements and inject them into
// the generator prompt as coverage/shape exemplars.
//
// Everything here is FAIL-OPEN: if the flag is off, the corpus is missing, or
// any call throws, retrieveExemplarBlock returns an empty block and the
// generator runs exactly as it does today.

import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { OCCUPATION_MATCH_SYSTEM_PROMPT } from '../prompts/task-generator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Master flag — off by default so the feature is inert until explicitly enabled.
export const RETRIEVAL_ENABLED = process.env.RETRIEVAL_ENABLED === 'true';

// A fast/cheap model for the occupation-match call (it only returns a name).
const MATCH_MODEL = process.env.MATCH_MODEL || process.env.SMALL_MODEL || 'gpt-4o-mini';
const RETRIEVAL_K = parseInt(process.env.RETRIEVAL_K || '20', 10);
const RETRIEVAL_TOP_OCCUPATIONS = parseInt(process.env.RETRIEVAL_TOP_OCCUPATIONS || '1', 10);
// Kept out of /app/data because production mounts a Cloud Storage bucket there.
const CORPUS_PATH = process.env.CORPUS_PATH || path.join(__dirname, '..', 'corpus', 'occupation-tasks.json');

// Lazy-loaded, cached corpus: Map<occupation, statements[]>. Loaded once per
// process on first use. On failure we clear the promise so a later call retries.
let corpusPromise = null;
function loadCorpus() {
  if (!corpusPromise) {
    corpusPromise = (async () => {
      const raw = await fs.readFile(CORPUS_PATH, 'utf-8');
      const data = JSON.parse(raw);
      const map = new Map();
      // Accept either [{occupation, statements[]}] or {occupation: statements[]}.
      if (Array.isArray(data)) {
        for (const row of data) {
          if (row && typeof row.occupation === 'string' && Array.isArray(row.statements)) {
            map.set(row.occupation, row.statements.filter(s => typeof s === 'string' && s.trim()));
          }
        }
      } else if (data && typeof data === 'object') {
        for (const [occ, stmts] of Object.entries(data)) {
          if (Array.isArray(stmts)) map.set(occ, stmts.filter(s => typeof s === 'string' && s.trim()));
        }
      }
      return map;
    })().catch(err => { corpusPromise = null; throw err; });
  }
  return corpusPromise;
}

// Cache occupation matches by a normalized profile key so repeat job titles
// skip the LLM call (a job title nearly always maps to the same occupation).
const matchCache = new Map();
function profileKey(p) {
  return `${p.jobTitle || ''}||${p.responsibilities || ''}||${p.typicalWeek || ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// One constrained LLM call: choose up to `n` occupation names from `occupations`.
async function matchOccupations(profile, occupations, n) {
  // Stable list prefix → benefits from automatic prompt caching across calls.
  const list = occupations.map((o, i) => `${i + 1}. ${o}`).join('\n');
  const resp = await client.chat.completions.create({
    model: MATCH_MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: OCCUPATION_MATCH_SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `OCCUPATIONS (choose ONLY from this list, copying names EXACTLY):\n${list}\n\n` +
          `PARTICIPANT:\nJob title: ${profile.jobTitle || ''}\n` +
          `Responsibilities: ${profile.responsibilities || ''}\n` +
          `Typical week: ${profile.typicalWeek || ''}\n\n` +
          `Return the ${n} best-matching occupation name(s) as JSON.`,
      },
    ],
  });
  const parsed = JSON.parse(resp.choices[0].message.content);
  const picks = Array.isArray(parsed.occupations) ? parsed.occupations : [];
  // Drop any hallucinated names not present in the corpus.
  const valid = new Set(occupations);
  return picks.filter(o => typeof o === 'string' && valid.has(o)).slice(0, n);
}

// Match → lookup. Returns the matched occupations and up to `k` statements.
export async function retrieveTaskStatements(
  profile,
  { k = RETRIEVAL_K, topOccupations = RETRIEVAL_TOP_OCCUPATIONS } = {},
) {
  const corpus = await loadCorpus();
  if (corpus.size === 0) return { occupations: [], statements: [] };

  const occupations = [...corpus.keys()];
  const key = profileKey(profile);
  let matched = matchCache.get(key);
  if (!matched) {
    matched = await matchOccupations(profile, occupations, topOccupations);
    matchCache.set(key, matched);
  }

  const statements = [];
  for (const occ of matched) {
    for (const s of corpus.get(occ) || []) {
      statements.push(s);
      if (statements.length >= k) break;
    }
    if (statements.length >= k) break;
  }
  return { occupations: matched, statements };
}

// Build the prompt block to splice into the generator's user message. Returns
// an empty block (fail-open) when disabled, on empty results, or on any error.
export async function retrieveExemplarBlock(profile) {
  if (!RETRIEVAL_ENABLED) return { block: '', occupations: [], count: 0 };
  try {
    const { occupations, statements } = await retrieveTaskStatements(profile);
    if (statements.length === 0) return { block: '', occupations, count: 0 };
    const block =
      `\nREAL TASK STATEMENTS FROM A SIMILAR OCCUPATION (${occupations.join(', ')}) — ` +
      `reference for COVERAGE and SHAPE only:\n` +
      statements.map(s => `- ${s}`).join('\n') +
      `\n\nUse these as (a) a checklist of categories someone in this role typically does and ` +
      `(b) a model for phrasing and granularity. DO NOT copy them verbatim, DO NOT include any ` +
      `that don't apply to THIS participant, and DO NOT reintroduce activities the participant ` +
      `already mentioned. The participant's own responsibilities and typical week always win.\n`;
    return { block, occupations, count: statements.length };
  } catch (err) {
    console.error('[retrieval]', err.message);
    return { block: '', occupations: [], count: 0 };
  }
}
