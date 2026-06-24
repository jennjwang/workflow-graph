// Client for the win-rate study. Pairs are blinded (no indication of which side
// is "ours"); the server records the randomized sides and scores after.

// Each side is a SET of statements (a matched group): usually one, but a side
// can list several when multiple statements from one method map to a single
// statement from the other (a 1-to-N fan). Never many-to-many.
export interface WinratePair {
  pairId: string;
  A: string[];
  B: string[];
}

export async function assignWinrate(
  externalId: string,
): Promise<{ items: WinratePair[] }> {
  const res = await fetch("/api/validation/winrate/assign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ externalId }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function submitWinrate(
  externalId: string,
  choices: { pairId: string; choice: "A" | "B" }[],
  meta: { startedAt?: string; elapsedMs?: number } = {},
): Promise<void> {
  const res = await fetch("/api/validation/winrate/response", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      externalId,
      choices,
      startedAt: meta.startedAt ?? null,
      elapsedMs: meta.elapsedMs ?? null,
    }),
  });
  if (!res.ok) throw new Error(await res.text());
}
