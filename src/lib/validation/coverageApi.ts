// Client for the held-out coverage study. Separate from the interview app's
// api.ts — the validation process shares no code with the interview flow.
import type { AllocationResult } from "../../components/validation/TimeAllocation";

export interface CoverageAssignment {
  assignmentId: string;
  occupation: string;
  statements: string[]; // method intentionally blinded
}

export interface FitResult {
  fit: boolean;
  confidence: number | null;
  reason: string | null;
}

// Second gate (after the screener): judge whether the participant's self-identified
// occupation is a good fit for the study target. Throws "RETRY" on a transient
// (503) failure so the UI can offer a retry instead of a wrong screen-out.
export async function judgeFit(
  externalId: string,
  selectedCode: string,
  selectedTitle: string,
  duties: string,
): Promise<FitResult> {
  const res = await fetch("/api/validation/coverage/fit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ externalId, selectedCode, selectedTitle, duties }),
  });
  if (res.status === 503) throw new Error("RETRY");
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function assignCoverage(
  externalId: string,
): Promise<CoverageAssignment> {
  const res = await fetch("/api/validation/coverage/assign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ externalId }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function submitCoverageResponse(
  externalId: string,
  result: AllocationResult,
  meta: { startedAt?: string; elapsedMs?: number; occupation?: unknown } = {},
): Promise<void> {
  const res = await fetch("/api/validation/coverage/response", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      externalId,
      totalHours: result.totalHours,
      allocations: result.allocations,
      startedAt: meta.startedAt ?? null,
      elapsedMs: meta.elapsedMs ?? null,
      occupation: meta.occupation ?? null,
    }),
  });
  if (!res.ok) throw new Error(await res.text());
}
