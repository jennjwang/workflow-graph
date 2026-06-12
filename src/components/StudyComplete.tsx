import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useWorkflowStore } from "../store";
import { saveSession } from "../lib/api";

const PROLIFIC_COMPLETION_URL = "https://app.prolific.com/submissions/complete";
const REDIRECT_DELAY_MS = 1500;

export function StudyComplete() {
  const { sessionId, getExportData, prolific } = useWorkflowStore(
    useShallow((s) => ({
      sessionId: s.sessionId,
      getExportData: s.getExportData,
      prolific: s.prolific,
    })),
  );

  const hasSaved = useRef(false);

  // Final defense-in-depth save in case the final-questions page's save
  // failed silently. Cheap to run again — the server upserts on sessionId.
  useEffect(() => {
    if (hasSaved.current) return;
    hasSaved.current = true;
    const data = getExportData() as Record<string, unknown>;
    saveSession(sessionId, undefined, undefined, undefined, data).catch(
      () => {},
    );
  }, [sessionId, getExportData]);

  // Auto-redirect to Prolific's completion URL after a brief pause so the
  // participant sees the thank-you message before the page changes.
  useEffect(() => {
    if (!prolific.pid || !prolific.completionCode) return;
    const code = prolific.completionCode;
    const t = setTimeout(() => {
      window.location.href = `${PROLIFIC_COMPLETION_URL}?cc=${encodeURIComponent(code)}`;
    }, REDIRECT_DELAY_MS);
    return () => clearTimeout(t);
  }, [prolific.pid, prolific.completionCode]);

  const redirecting = Boolean(prolific.pid && prolific.completionCode);

  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center px-5 sm:px-8 py-16">
      <div className="absolute top-0 left-0 right-0 h-56 bg-gradient-to-b from-indigo-50/30 to-transparent pointer-events-none" />

      <div className="relative max-w-2xl w-full text-center">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-emerald-50 border-2 border-emerald-200 mb-8">
          <svg
            className="w-7 h-7 text-emerald-500"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>

        <h1 className="text-[1.85rem] font-light text-slate-800 leading-snug tracking-tight mb-4">
          Thank you for your response.
        </h1>
        <p className="text-sm text-slate-500 leading-relaxed">
          {redirecting
            ? "Redirecting you back to Prolific…"
            : "Your answers have been recorded."}
        </p>
      </div>
    </div>
  );
}
