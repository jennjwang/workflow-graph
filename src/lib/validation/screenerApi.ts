// Shared occupation screener client (used by every validation study). Classifies
// by described duties (title is a secondary hint), server-side, against the
// target O*NET occupation. Throws "RETRY" on a transient (503) failure so the UI
// can distinguish "try again" from a genuine non-match.

export interface VerifyResult {
  match: boolean;
  confidence: number | null;
  reason: string | null;
}

export async function verifyOccupation(
  externalId: string,
  title: string,
  description: string,
): Promise<VerifyResult> {
  const res = await fetch("/api/validation/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ externalId, title, description }),
  });
  if (res.status === 503) throw new Error("RETRY");
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
