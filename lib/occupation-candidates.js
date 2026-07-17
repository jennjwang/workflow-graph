// Occupation self-ID candidate generator for the final interview screen.
//
// Method (B): ONE LLM call over the full O*NET-SOC list. We give the model the
// whole interview transcript plus every SOC occupation (code + title) and ask
// for the ranked TOP N (default 3) best-fit occupations. The model reads holistically (it is
// NOT fooled by domain-keyword density the way embedding retrieval is on long
// transcripts), and we validate every returned code against the real list so a
// hallucinated/mis-typed code can never reach the participant.
//
// The participant resolves the final pick on the screen, so this is a RECALL
// tool, not a precision one: a decent shortlist + the "show different" (excludeCodes
// + optional steerable hint) loop + free search. Fails open: on any error it
// returns [] and the screen falls back to plain search over the full list.

import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
});

// Strong model (the shortlist is a hard-to-fake reasoning task); validated on
// gpt-5.4. Reasoning models reject an explicit temperature, so only send it to
// non-reasoning models.
const OCCUPATION_MODEL = process.env.OCCUPATION_MODEL || 'gpt-5.4';
const SOC_PATH = process.env.SOC_PATH || path.join(__dirname, '..', 'data', 'onet-soc.json');
const TOP_N = parseInt(process.env.OCCUPATION_TOP_N || '3', 10);

const isReasoning = (m) => /^(o1|o3|o4|gpt-5)/.test(m);

// Lazy-loaded SOC list: [{code,title,definition}]. Cached per process; on failure
// the promise is cleared so a later call retries.
let socPromise = null;
function loadSoc() {
  if (!socPromise) {
    socPromise = fs.readFile(SOC_PATH, 'utf-8').then(JSON.parse).catch((err) => {
      socPromise = null;
      throw err;
    });
  }
  return socPromise;
}

// Full SOC list (code + title + definition) for the screen's "search all
// occupations" fallback — the definition lets the search list show the same duty
// bullets as the ranked candidates. Returns [] on failure (the box shows nothing).
export async function listOccupations() {
  try {
    const soc = await loadSoc();
    return soc.map((o) => ({ code: o.code, title: o.title, definition: o.definition }));
  } catch (err) {
    console.error('[occupation-candidates] listOccupations', err);
    return [];
  }
}

function transcriptText(backgroundTranscript = []) {
  return backgroundTranscript
    .filter((t) => t && typeof t.answer === 'string' && t.answer.trim())
    .map((t) => `Q: ${(t.question || '').trim()}\nA: ${t.answer.trim()}`)
    .join('\n');
}

// Return the ranked top-N SOC candidates for a transcript.
//   excludeCodes : codes already shown ("show different options")
//   hint         : optional participant steer ("none fit because… more technical")
// Each item: { code, title, definition, why }. Returns [] on any failure (fail-open).
export async function occupationCandidates(backgroundTranscript, { excludeCodes = [], hint = '' } = {}) {
  try {
    const role = transcriptText(backgroundTranscript);
    if (!role) return [];
    const soc = await loadSoc();
    const byCode = new Map(soc.map((o) => [o.code, o]));
    // Title index (case-insensitive) so a returned occupation whose CODE is
    // mistyped can still be recovered by its title instead of being dropped.
    const byTitle = new Map(soc.map((o) => [o.title.toLowerCase().trim(), o]));
    const exclude = new Set(excludeCodes);
    const list = soc
      .filter((o) => !exclude.has(o.code))
      .map((o) => `${o.code} ${o.title}`)
      .join('\n');

    const excludeBlock = excludeCodes.length
      ? `\nThe participant has already rejected these — do NOT return them:\n${excludeCodes.join(', ')}\n`
      : '';
    const hintBlock = hint && hint.trim()
      ? `\nThe participant says none of the previous options fit, because: "${hint.trim()}". Weight this strongly.\n`
      : '';

    // Ask for MORE than TOP_N so we can deterministically drop residual "All
    // Other" catch-alls and still have enough specific occupations to fill the
    // slots (the model is inconsistent about doing this itself).
    const RETURN_N = TOP_N + 5;
    const prompt =
      `You are an expert occupation coder. From the FULL O*NET-SOC 2019 list below, pick the TOP ${RETURN_N} ` +
      `occupations the worker would most identify with, best first, by matching their PRIMARY activities ` +
      `to the occupations. Use codes and titles EXACTLY as listed.\n` +
      `Prefer SPECIFIC occupations. Residual catch-all categories whose title ends in "All Other" ` +
      `(e.g. "Physicians, All Other", "Managers, All Other") are a LAST RESORT: rank any such category BELOW ` +
      `every specific occupation that could plausibly fit the worker.\n${excludeBlock}${hintBlock}\n` +
      `Worker interview transcript:\n${role}\n\n` +
      `O*NET-SOC occupations (code title):\n${list}\n\n` +
      `Return ONLY JSON: {"ranked":[{"code":"##-####.##","title":"...","why":"<=12 words why it fits"}, ... ${RETURN_N} items]}`;

    const params = {
      model: OCCUPATION_MODEL,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    };
    if (!isReasoning(OCCUPATION_MODEL)) params.temperature = 0;

    const resp = await client.chat.completions.create(params);
    const parsed = JSON.parse(resp.choices[0].message.content);
    const ranked = Array.isArray(parsed.ranked) ? parsed.ranked : [];

    // Resolve each returned item to a REAL occupation — by code first, then by
    // exact title — so a mistyped code is recovered rather than dropped. The
    // title + definition shown always come from canonical data, never the model's
    // text, so a hallucinated code can't reach the participant. De-dup, drop
    // already-rejected codes.
    const seen = new Set();
    const resolved = [];
    for (const r of ranked) {
      const occ = byCode.get(r && r.code) || byTitle.get((r && r.title || '').toLowerCase().trim());
      if (!occ || seen.has(occ.code) || exclude.has(occ.code)) continue;
      seen.add(occ.code);
      resolved.push({ code: occ.code, title: occ.title, definition: occ.definition, why: (r.why || '').trim() });
    }
    // Prefer specific occupations: take specifics first (best-first order
    // preserved), then backfill with "All Other" catch-alls only if specifics
    // don't fill TOP_N. So an "All Other" bucket shows up ONLY when there aren't
    // enough specific matches.
    const isAllOther = (t) => /\ball other\b/i.test(t || '');
    const specific = resolved.filter((o) => !isAllOther(o.title));
    const allOther = resolved.filter((o) => isAllOther(o.title));
    const out = [...specific, ...allOther].slice(0, TOP_N);
    return out;
  } catch (err) {
    console.error('[occupation-candidates]', err);
    return [];
  }
}

// Return the ranked top-N SOC candidates for a free-text job query (used by the
// SOC-FIRST variant, where the participant searches for their occupation at the
// START of the study, before the interview — so there is no transcript to rank
// from, only what they typed). `query` is the participant's job title and/or a
// short description of what they do.
//   excludeCodes : codes already shown ("show different options")
//   hint         : optional participant steer ("none fit because… more technical")
// Each item: { code, title, definition, why }. Returns [] on any failure (fail-open),
// in which case the screen falls back to plain search over the full SOC list.
export async function occupationSearch(query, { excludeCodes = [], hint = '' } = {}) {
  try {
    const q = typeof query === 'string' ? query.trim() : '';
    if (!q) return [];
    const soc = await loadSoc();
    const byCode = new Map(soc.map((o) => [o.code, o]));
    const byTitle = new Map(soc.map((o) => [o.title.toLowerCase().trim(), o]));
    const exclude = new Set(excludeCodes);
    const list = soc
      .filter((o) => !exclude.has(o.code))
      .map((o) => `${o.code} ${o.title}`)
      .join('\n');

    const excludeBlock = excludeCodes.length
      ? `\nThe participant has already rejected these — do NOT return them:\n${excludeCodes.join(', ')}\n`
      : '';
    const hintBlock = hint && hint.trim()
      ? `\nThe participant says none of the previous options fit, because: "${hint.trim()}". Weight this strongly.\n`
      : '';

    // Ask for MORE than TOP_N so we can deterministically drop residual "All
    // Other" catch-alls and still have enough specific occupations to fill the
    // slots (the model is inconsistent about doing this itself).
    const RETURN_N = TOP_N + 5;
    const prompt =
      `You are an expert occupation coder. From the FULL O*NET-SOC 2019 list below, pick the TOP ${RETURN_N} ` +
      `occupations that best match the worker's job title and description, best first. Match on what the ` +
      `worker actually does, not just literal title words. Use codes and titles EXACTLY as listed.\n` +
      `Prefer SPECIFIC occupations. Residual catch-all categories whose title ends in "All Other" ` +
      `(e.g. "Physicians, All Other", "Managers, All Other") are a LAST RESORT: rank any such category BELOW ` +
      `every specific occupation that could plausibly fit the worker — e.g. for a generic "doctor", rank the ` +
      `specific physician types (Family Medicine, Emergency Medicine, General Internal Medicine, ` +
      `Pediatricians, etc.) above any "All Other" bucket.\n${excludeBlock}${hintBlock}\n` +
      `Worker's job title / description:\n"""${q}"""\n\n` +
      `O*NET-SOC occupations (code title):\n${list}\n\n` +
      `Return ONLY JSON: {"ranked":[{"code":"##-####.##","title":"...","why":"<=12 words why it fits"}, ... ${RETURN_N} items]}`;

    const params = {
      model: OCCUPATION_MODEL,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    };
    if (!isReasoning(OCCUPATION_MODEL)) params.temperature = 0;

    const resp = await client.chat.completions.create(params);
    const parsed = JSON.parse(resp.choices[0].message.content);
    const ranked = Array.isArray(parsed.ranked) ? parsed.ranked : [];

    // Resolve every returned item to a REAL occupation (code first, then exact
    // title) so a mistyped code is recovered rather than dropped, and a
    // hallucinated code can never reach the participant. De-dup, drop rejected
    // codes. Keep the model's best-first order; trim to TOP_N below.
    const seen = new Set();
    const resolved = [];
    for (const r of ranked) {
      const occ = byCode.get(r && r.code) || byTitle.get((r && r.title || '').toLowerCase().trim());
      if (!occ || seen.has(occ.code) || exclude.has(occ.code)) continue;
      seen.add(occ.code);
      resolved.push({ code: occ.code, title: occ.title, definition: occ.definition, why: (r.why || '').trim() });
    }
    // Prefer specific occupations: take specifics first (best-first order
    // preserved), then backfill with "All Other" catch-alls only if specifics
    // don't fill TOP_N. So an "All Other" bucket shows up ONLY when there aren't
    // enough specific matches.
    const isAllOther = (t) => /\ball other\b/i.test(t || '');
    const specific = resolved.filter((o) => !isAllOther(o.title));
    const allOther = resolved.filter((o) => isAllOther(o.title));
    const out = [...specific, ...allOther].slice(0, TOP_N);
    return out;
  } catch (err) {
    console.error('[occupation-search]', err);
    return [];
  }
}
