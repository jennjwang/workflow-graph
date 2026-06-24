import { useMemo, useState } from "react";
import { TimeAllocation, AllocationResult } from "./TimeAllocation";
import { CoverageTaskCards } from "./CoverageTaskCards";
import { Frame, Centered, resolveExternalId } from "./validationUi";
import { OccupationScreener } from "./OccupationScreener";
import {
  assignCoverage,
  submitCoverageResponse,
  CoverageAssignment,
} from "../../lib/validation/coverageApi";

// Held-out coverage study. Standalone entry (mounted from main.tsx on
// ?study=coverage) — it does NOT use the interview phase machine or store.
//
// Flow: occupation screener (title + duties → server-side LLM match) gates
// everything. On a pass we assign one inventory at random (method blinded), ask
// total weekly hours, walk each task one at a time ("do you do this?" → hours),
// then show an adjustable summary seeded from those answers; the residual goes to
// "Other." A non-match ends the study.

type Stage =
  | "no-id"
  | "screen"
  | "assigning"
  | "total"
  | "cards"
  | "summary"
  | "done"
  | "screened-out"
  | "error";

export function CoverageStudy() {
  const externalId = useMemo(resolveExternalId, []);
  const [stage, setStage] = useState<Stage>(externalId ? "screen" : "no-id");
  const [assignment, setAssignment] = useState<CoverageAssignment | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [startedAt] = useState(() => new Date().toISOString());

  // Total weekly hours (denominator) + per-task hours collected in the card pass.
  const [totalHours, setTotalHours] = useState<number | null>(null);
  const [totalInput, setTotalInput] = useState("");
  const [cardHours, setCardHours] = useState<Record<string, number>>({});

  const handlePass = async () => {
    setStage("assigning");
    try {
      const a = await assignCoverage(externalId);
      setAssignment(a);
      setStage("total");
    } catch (e) {
      setError(String((e as Error)?.message || e));
      setStage("error");
    }
  };

  const handleSubmit = async (result: AllocationResult) => {
    if (!externalId) return;
    setSubmitting(true);
    try {
      await submitCoverageResponse(externalId, result, {
        startedAt,
        elapsedMs: Date.now() - new Date(startedAt).getTime(),
      });
      setStage("done");
    } catch (e) {
      setError(String((e as Error)?.message || e));
      setStage("error");
    } finally {
      setSubmitting(false);
    }
  };

  if (stage === "no-id") {
    return (
      <Frame>
        <Centered>
          <h1 className="text-2xl font-light text-slate-800">
            Missing participant ID
          </h1>
          <p className="mt-3 text-sm text-slate-500">
            This link needs a participant ID. Please use the full link you were
            given (it ends with <code>?study=coverage&amp;PROLIFIC_PID=…</code>).
          </p>
        </Centered>
      </Frame>
    );
  }

  if (stage === "screen") {
    return (
      <Frame>
        <OccupationScreener
          externalId={externalId}
          onPass={handlePass}
          onFail={() => setStage("screened-out")}
          onError={(msg) => {
            setError(msg);
            setStage("error");
          }}
        />
      </Frame>
    );
  }

  if (stage === "assigning") {
    return (
      <Frame>
        <Centered>
          <p className="text-sm text-slate-400">Loading…</p>
        </Centered>
      </Frame>
    );
  }

  if (stage === "screened-out") {
    return (
      <Frame>
        <Centered>
          <h1 className="text-2xl font-light text-slate-800">
            Thanks for your interest
          </h1>
          <p className="mt-3 text-sm text-slate-500">
            Based on your responses, this study isn't a match for your
            background. We appreciate your time.
          </p>
        </Centered>
      </Frame>
    );
  }

  if (stage === "error") {
    return (
      <Frame>
        <Centered>
          <h1 className="text-2xl font-light text-slate-800">
            Something went wrong
          </h1>
          <p className="mt-3 text-sm text-slate-500">{error}</p>
        </Centered>
      </Frame>
    );
  }

  if (stage === "done") {
    return (
      <Frame>
        <Centered>
          <h1 className="text-2xl font-light text-slate-800">Thank you!</h1>
          <p className="mt-3 text-sm text-slate-500">
            Your responses have been recorded. You may close this window.
          </p>
        </Centered>
      </Frame>
    );
  }

  if (stage === "total") {
    const parsed = parseFloat(totalInput);
    const valid = Number.isFinite(parsed) && parsed > 0;
    return (
      <Frame>
        <Centered>
          <h1 className="text-2xl font-light text-slate-800 leading-snug">
            In an average week, how many hours do you work?
          </h1>
          <p className="mt-3 text-sm text-slate-500 leading-relaxed">
            Your best estimate of total hours across all your work in a typical
            week. Next we'll go through your tasks one at a time.
          </p>
          <div className="mt-6 flex items-center justify-center gap-3">
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step={0.5}
              autoFocus
              value={totalInput}
              onChange={(e) => setTotalInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && valid) {
                  setTotalHours(parsed);
                  setStage("cards");
                }
              }}
              className="w-28 rounded-xl border border-slate-200 bg-white px-4 py-3 text-lg text-center text-slate-800 tabular-nums transition focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-200"
            />
            <span className="text-sm text-slate-500">hours / week</span>
          </div>
          <div className="mt-8 flex justify-center">
            <button
              onClick={() => {
                setTotalHours(parsed);
                setStage("cards");
              }}
              disabled={!valid}
              className="inline-flex items-center gap-2 px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-30 disabled:cursor-not-allowed text-white text-sm font-medium rounded-full transition-all active:scale-[0.98] shadow-sm shadow-indigo-200"
            >
              Continue
            </button>
          </div>
        </Centered>
      </Frame>
    );
  }

  if (stage === "cards" && assignment) {
    return (
      <Frame>
        <CoverageTaskCards
          statements={assignment.statements}
          onDone={(hoursByKey) => {
            setCardHours(hoursByKey);
            setStage("summary");
          }}
        />
      </Frame>
    );
  }

  if (stage === "summary" && assignment) {
    const rows = assignment.statements.map((name, i) => ({
      key: `s${i}`,
      name,
    }));
    const covered = Object.values(cardHours).reduce((s, h) => s + h, 0);
    const residual = Math.max(0, (totalHours ?? 0) - covered);
    return (
      <Frame>
        <TimeAllocation
          rows={rows}
          initialStep="breakdown"
          initialTotalHours={totalHours}
          initialHours={cardHours}
          initialOtherHours={residual}
          breakdownHelp="Here's your week based on your answers. Drag to fine-tune, and put any time these tasks don't capture into “Other.”"
          submitting={submitting}
          onSubmit={handleSubmit}
        />
      </Frame>
    );
  }

  return null;
}
