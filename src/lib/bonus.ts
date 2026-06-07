// Master switch for the participant bonus feature. When false, all bonus UI is
// hidden and every earned amount is forced to $0 (nothing is earned or
// recorded). Flip to true to restore the incentive across both phases.
export const BONUS_ENABLED = false;

// Edit-bonus pool for the workflow-mapping phase. Same per-character rate as
// the task-selection edit bonus, but a separate cap so the two pools can be
// tuned independently.
export const MAPPING_EDIT_BONUS_PER_CHAR_USD = 0.001;
export const MAPPING_EDIT_BONUS_MAX_USD = 1.5;
// Flat bonus per manually-added subtask in the mapping phase. Separate from
// the per-character edit pool so adding a node is rewarded as its own act.
export const MAPPING_ADD_NODE_BONUS_USD = 0.05;
export const MAPPING_ADD_NODE_BONUS_MAX_USD = 1.0;

// Levenshtein distance — counts insertions, deletions, and substitutions.
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m = a.length, n = b.length;
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      );
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

export function formatUsd(n: number) {
  return `$${n.toFixed(2)}`;
}

export function mappingEditBonusUsd(
  editChars: number,
  addedNodes: number,
): {
  usd: number;
  capped: boolean;
  editUsd: number;
  addUsd: number;
  maxUsd: number;
} {
  if (!BONUS_ENABLED) {
    return { usd: 0, capped: false, editUsd: 0, addUsd: 0, maxUsd: 0 };
  }
  const editRaw = editChars * MAPPING_EDIT_BONUS_PER_CHAR_USD;
  const editUsd = Math.min(editRaw, MAPPING_EDIT_BONUS_MAX_USD);
  const editCapped = editRaw >= MAPPING_EDIT_BONUS_MAX_USD;
  const addRaw = addedNodes * MAPPING_ADD_NODE_BONUS_USD;
  const addUsd = Math.min(addRaw, MAPPING_ADD_NODE_BONUS_MAX_USD);
  const addCapped = addRaw >= MAPPING_ADD_NODE_BONUS_MAX_USD;
  return {
    usd: editUsd + addUsd,
    capped: editCapped && addCapped,
    editUsd,
    addUsd,
    maxUsd: MAPPING_EDIT_BONUS_MAX_USD + MAPPING_ADD_NODE_BONUS_MAX_USD,
  };
}
