import { useMemo, useState } from "react";
import { Frame, Centered, resolveExternalId } from "./validationUi";
import { OccupationScreener } from "./OccupationScreener";
import { PairwiseJudgment } from "./PairwiseJudgment";
import { assignWinrate, submitWinrate, WinratePair } from "../../lib/validation/winrateApi";

// Held-out win-rate study. Standalone entry (?study=winrate). Screener gates;
// on a pass the participant judges every matched pair (forced A-vs-B, sides
// randomized server-side) for which statement better describes their work.

type Stage =
  | "no-id"
  | "screen"
  | "assigning"
  | "judge"
  | "done"
  | "unavailable"
  | "screened-out"
  | "error";

export function WinRateStudy() {
  const externalId = useMemo(resolveExternalId, []);
  const [stage, setStage] = useState<Stage>(externalId ? "screen" : "no-id");
  const [items, setItems] = useState<WinratePair[]>([]);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [startedAt] = useState(() => new Date().toISOString());

  const handlePass = async () => {
    setStage("assigning");
    try {
      const { items } = await assignWinrate(externalId);
      if (items.length === 0) {
        setStage("unavailable");
        return;
      }
      setItems(items);
      setStage("judge");
    } catch (e) {
      setError(String((e as Error)?.message || e));
      setStage("error");
    }
  };

  const handleDone = async (
    choices: { pairId: string; choice: "A" | "B" }[],
  ) => {
    setSubmitting(true);
    try {
      await submitWinrate(externalId, choices, {
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
            given (it ends with <code>?study=winrate&amp;PROLIFIC_PID=…</code>).
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

  if (stage === "unavailable") {
    return (
      <Frame>
        <Centered>
          <h1 className="text-2xl font-light text-slate-800">
            No comparisons available
          </h1>
          <p className="mt-3 text-sm text-slate-500">
            There are no matched task pairs to review for this occupation right
            now. Thanks for your time.
          </p>
        </Centered>
      </Frame>
    );
  }

  if (stage === "judge" && items.length > 0) {
    return (
      <Frame>
        <PairwiseJudgment
          items={items}
          submitting={submitting}
          onDone={handleDone}
        />
      </Frame>
    );
  }

  return null;
}
