// Shared paths + loaders for the validation process. No dependency on the app.
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const VALIDATION_DIR = path.join(__dirname, '..');
export const INPUTS_DIR = path.join(VALIDATION_DIR, 'inputs');
export const OUT_DIR = path.join(VALIDATION_DIR, 'out');
export const RESPONSES_DIR = path.join(OUT_DIR, 'responses');
export const ASSIGNMENTS_DIR = path.join(OUT_DIR, 'assignments');

export async function readJson(filePath, fallback = undefined) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw err;
  }
}

// Canonical inventories shape:
//   { occupation, methods: { <key>: { label, statements: string[] } } }
export async function loadInventories() {
  const data = await readJson(path.join(INPUTS_DIR, 'inventories.json'));
  if (!data || typeof data.methods !== 'object') {
    throw new Error('inventories.json: expected { occupation, methods: {...} }');
  }
  return data;
}

export function methodKeys(inventories) {
  return Object.keys(inventories.methods);
}

export function statementsFor(inventories, method) {
  const m = inventories.methods[method];
  if (!m || !Array.isArray(m.statements)) {
    throw new Error(`unknown method or missing statements: ${method}`);
  }
  return m.statements;
}

// Read every response file in a study's responses dir as parsed objects.
async function loadResponses(study) {
  const dir = path.join(RESPONSES_DIR, study);
  let names = [];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith('.json'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const name of names) {
    out.push(await readJson(path.join(dir, name)));
  }
  return out;
}

export const loadCoverageResponses = () => loadResponses('coverage');
