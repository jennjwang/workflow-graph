import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useWorkflowStore } from "../store";
import { saveSession } from "../lib/api";

const RATING_LABELS: Record<number, string> = {
  1: "Poor",
  2: "Fair",
  3: "OK",
  4: "Good",
  5: "Great",
};

// Per-button captions for the "Not at all → Very" degree scales (interviewer +
// task generator), so they read like the overall-experience question.
const DEGREE_LABELS: Record<number, string> = {
  1: "Not at all",
  2: "A little",
  3: "Somewhat",
  4: "Mostly",
  5: "Very",
};

// Reusable 1–5 scale. Pass `labels` to caption each button (used for the overall
// experience question); otherwise endpoint hints (`lowLabel`/`highLabel`) keep
// stage questions readable without per-number captions.
function RatingScale({
  value,
  onChange,
  disabled,
  labels,
  lowLabel,
  highLabel,
}: {
  value: number | null;
  onChange: (n: number) => void;
  disabled?: boolean;
  labels?: Record<number, string>;
  lowLabel?: string;
  highLabel?: string;
}) {
  return (
    <>
      {(lowLabel || highLabel) && (
        <p className="text-xs text-slate-500 mb-4">
          1 = {lowLabel}, 5 = {highLabel}
        </p>
      )}
      <div className="flex gap-1.5 sm:gap-2">
        {[1, 2, 3, 4, 5].map((n) => {
          const selected = value === n;
          return (
            <button
              key={n}
              type="button"
              onClick={() => onChange(n)}
              disabled={disabled}
              className={`flex-1 py-3 rounded-xl border text-sm font-medium transition ${
                selected
                  ? "border-indigo-400 bg-indigo-50 text-indigo-700"
                  : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50"
              } disabled:opacity-60`}
              aria-pressed={selected}
              aria-label={labels ? `${n} — ${labels[n]}` : `${n}`}
            >
              <span className="block text-base font-semibold">{n}</span>
              {labels && (
                <span className="block text-[11px] mt-0.5 opacity-70">
                  {labels[n]}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </>
  );
}

export function FinalQuestions() {
  const { sessionId, getExportData, setPhase, setFinalAnswers } = useWorkflowStore(
    useShallow((s) => ({
      sessionId: s.sessionId,
      getExportData: s.getExportData,
      setPhase: s.setPhase,
      setFinalAnswers: s.setFinalAnswers,
    })),
  );

  const [rating, setRating] = useState<number | null>(null);
  const [feedback, setFeedback] = useState("");
  const [interviewRating, setInterviewRating] = useState<number | null>(null);
  const [interviewComment, setInterviewComment] = useState("");
  const [selectionRating, setSelectionRating] = useState<number | null>(null);
  const [selectionComment, setSelectionComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const hasSafetyNetSaved = useRef(false);

  // Safety-net save on mount — preserves the participant's response even if
  // they close the tab before answering these final questions.
  useEffect(() => {
    if (hasSafetyNetSaved.current) return;
    hasSafetyNetSaved.current = true;
    const data = getExportData() as Record<string, unknown>;
    saveSession(sessionId, undefined, undefined, undefined, data).catch(
      () => {},
    );
  }, [sessionId, getExportData]);

  // Every rating is required; the free-text comments are optional.
  const canSubmit =
    rating !== null &&
    interviewRating !== null &&
    selectionRating !== null &&
    feedback.trim() !== "";

  async function submit() {
    if (submitting || !canSubmit) return;
    setSubmitting(true);
    const trimmed = feedback.trim();
    const trimmedInterview = interviewComment.trim();
    const trimmedSelection = selectionComment.trim();
    // Persist into the store first so the defense-in-depth save fired from
    // StudyComplete's mount effect carries these fields too (otherwise it
    // overwrites the file with a payload that lacks them).
    setFinalAnswers({
      experienceRating: rating!,
      feedback: trimmed,
      interviewRating,
      interviewComment: trimmedInterview,
      selectionRating,
      selectionComment: trimmedSelection,
    });
    const data = getExportData() as Record<string, unknown>;
    const payload: Record<string, unknown> = {
      ...data,
      experienceRating: rating,
      feedback: trimmed,
      interviewRating,
      interviewComment: trimmedInterview,
      selectionRating,
      selectionComment: trimmedSelection,
    };
    try {
      await saveSession(sessionId, undefined, undefined, undefined, payload);
    } catch {
      // Best-effort — proceed to the thank-you screen regardless.
    }
    setPhase("study-complete");
  }

  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center px-5 sm:px-8 py-12 sm:py-16">
      <div className="absolute top-0 left-0 right-0 h-56 bg-gradient-to-b from-indigo-50/30 to-transparent pointer-events-none" />

      <div className="relative max-w-2xl w-full">
        <h1 className="text-[1.5rem] sm:text-[1.85rem] font-light text-slate-800 leading-snug tracking-tight mb-2">
          A few final questions.
        </h1>
        <p className="text-sm text-slate-500 leading-relaxed mb-10">
          Your feedback helps us improve our study.
        </p>

        <div className="mb-10">
          <p className="block text-sm font-medium text-slate-700 mb-1">
            How was your experience with this study overall?
          </p>
          <RatingScale
            value={rating}
            onChange={setRating}
            disabled={submitting}
            labels={RATING_LABELS}
            lowLabel="Poor"
            highLabel="Great"
          />
        </div>

        {/* Feedback on the AI interviewer */}
        <div className="mb-10 pt-2 border-t border-slate-100">
          <p className="block text-sm font-medium text-slate-700 mb-1 mt-6">
            How relevant and well-targeted were the interviewer's questions?
          </p>
          <RatingScale
            value={interviewRating}
            onChange={setInterviewRating}
            disabled={submitting}
            labels={DEGREE_LABELS}
            lowLabel="Not at all"
            highLabel="Very"
          />
          <label
            htmlFor="interview-comment"
            className="block text-xs text-slate-500 mt-4 mb-2"
          >
            Anything it misunderstood or should have asked?
          </label>
          <textarea
            id="interview-comment"
            value={interviewComment}
            onChange={(e) => setInterviewComment(e.target.value)}
            disabled={submitting}
            rows={3}
            placeholder="Type here…"
            className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-50"
          />
        </div>

        {/* Feedback on the task generator — the tasks the participant reviewed
            one by one were generated from their interview. */}
        <div className="mb-10 pt-2 border-t border-slate-100">
          <p className="block text-sm font-medium text-slate-700 mb-1 mt-6">
            How accurate and relevant were the tasks we generated for you?
          </p>
          <RatingScale
            value={selectionRating}
            onChange={setSelectionRating}
            disabled={submitting}
            labels={DEGREE_LABELS}
            lowLabel="Not at all"
            highLabel="Very"
          />
          <label
            htmlFor="selection-comment"
            className="block text-xs text-slate-500 mt-4 mb-2"
          >
            Anything off — wrong, unclear, or repetitive?
          </label>
          <textarea
            id="selection-comment"
            value={selectionComment}
            onChange={(e) => setSelectionComment(e.target.value)}
            disabled={submitting}
            rows={3}
            placeholder="Type here…"
            className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-50"
          />
        </div>

        <div className="mb-10 pt-2 border-t border-slate-100">
          <label
            htmlFor="study-feedback"
            className="block text-sm font-medium text-slate-700 mb-1 mt-6"
          >
            Any other feedback or comments?
          </label>
          <p className="text-xs text-slate-500 mb-3">
            What worked well, what was confusing, anything we should know.
          </p>
          <textarea
            id="study-feedback"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            disabled={submitting}
            rows={5}
            placeholder="Type here…"
            className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100 disabled:bg-slate-50"
          />
        </div>

        <button
          type="button"
          onClick={submit}
          disabled={submitting || !canSubmit}
          className="inline-block px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 disabled:cursor-not-allowed text-white text-sm font-medium rounded-xl transition"
        >
          {submitting ? "Submitting…" : "Submit"}
        </button>
      </div>
    </div>
  );
}
