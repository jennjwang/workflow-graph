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
  reason: string | null;
}

// The coverage screener: a deterministic check that the self-identified
// occupation IS the study target (selected O*NET code == target code).
export async function judgeFit(
  externalId: string,
  selectedCode: string,
  selectedTitle: string,
): Promise<FitResult> {
  const res = await fetch("/api/validation/coverage/fit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ externalId, selectedCode, selectedTitle }),
  });
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
