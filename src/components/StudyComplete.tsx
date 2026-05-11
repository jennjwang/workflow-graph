import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useWorkflowStore } from "../store";
import { saveSession } from "../lib/api";

const PROLIFIC_REDIRECT_DELAY_MS = 1500;
const PROLIFIC_COMPLETION_URL = "https://app.prolific.com/submissions/complete";

export function StudyComplete() {
  const { sessionId, getExportData, prolific } = useWorkflowStore(
    useShallow((s) => ({
      sessionId: s.sessionId,
      getExportData: s.getExportData,
      prolific: s.prolific,
    })),
  );

  const [saveState, setSaveState] = useState<"saving" | "saved" | "error">(
    "saving",
  );
  const [redirecting, setRedirecting] = useState(false);
  const hasSaved = useRef(false);

  // Auto-save the response to the server when the participant lands on this screen.
  useEffect(() => {
    if (hasSaved.current) return;
    hasSaved.current = true;
    const exportData = getExportData() as {
      userProfile: unknown;
      backgroundTranscript: unknown;
      selectedTasks: unknown;
      taskItems: unknown;
      bonusSnapshot: unknown;
    };
    // Positional coreTask/workflow/messages are intentionally omitted — this
    // study flow doesn't use them, and saveSession now only includes provided
    // fields in the persisted JSON.
    saveSession(
      sessionId,
      undefined,
      undefined,
      undefined,
      {
        userProfile: exportData.userProfile,
        backgroundTranscript: exportData.backgroundTranscript,
        selectedTasks: exportData.selectedTasks,
        taskItems: exportData.taskItems,
        bonusSnapshot: exportData.bonusSnapshot,
        prolific: prolific,
      },
    )
      .then(() => setSaveState("saved"))
      .catch(() => setSaveState("error"));
  }, [sessionId, getExportData, prolific]);

  // After a successful save, if this is a Prolific session, redirect back to
  // Prolific with the completion code so the participant gets credit. We add
  // a brief pause so the participant sees the "Saved" confirmation first.
  useEffect(() => {
    if (saveState !== "saved") return;
    if (!prolific.pid || !prolific.completionCode) return;
    setRedirecting(true);
    const timer = setTimeout(() => {
      const url = `${PROLIFIC_COMPLETION_URL}?cc=${encodeURIComponent(prolific.completionCode!)}`;
      window.location.href = url;
    }, PROLIFIC_REDIRECT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [saveState, prolific.pid, prolific.completionCode]);

  const downloadBackup = () => {
    const data = getExportData();
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `study-response-${sessionId.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center px-8 py-16">
      <div className="absolute top-0 left-0 right-0 h-56 bg-gradient-to-b from-indigo-50/30 to-transparent pointer-events-none" />

      <div className="relative max-w-xl w-full text-center">
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
          Thanks for your responses.
        </h1>
        <p className="text-sm text-slate-500 leading-relaxed mb-10 max-w-md mx-auto">
          Your answers have been recorded.
          {redirecting && " Returning you to Prolific…"}
        </p>

        {/* <div className="border border-slate-200 rounded-2xl p-5 bg-slate-50/50 text-left mb-8"> */}
        {/* <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400 mb-3"> */}
        {/* Summary */}
        {/* </p>
          <dl className="space-y-2.5 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">Role</dt>
              <dd className="text-slate-700 text-right truncate">{userProfile?.jobTitle || '—'}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">Tasks selected</dt>
              <dd className="text-slate-700 text-right">{selectedTasks?.length ?? 0}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">Submission</dt>
              <dd className="text-slate-700 text-right">
                {saveState === 'saving' && <span className="text-slate-400">Saving…</span>}
                {saveState === 'saved' && <span className="text-emerald-600">✓ Saved</span>}
                {saveState === 'error' && <span className="text-red-500">Couldn't save — please download backup</span>}
              </dd> */}
        {/* </div> */}
        {/* </dl> */}
        {/* </div> */}

        {prolific.pid && prolific.completionCode ? (
          <a
            href={`${PROLIFIC_COMPLETION_URL}?cc=${encodeURIComponent(prolific.completionCode)}`}
            className="inline-block px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-xl transition"
          >
            Return to Prolific →
          </a>
        ) : (
          <button
            onClick={downloadBackup}
            className="text-sm text-slate-500 hover:text-slate-700 underline-offset-4 hover:underline transition"
          >
            Download a copy of your response
          </button>
        )}
      </div>
    </div>
  );
}
