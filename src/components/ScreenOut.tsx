import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useWorkflowStore } from '../store';
import { saveSession } from '../lib/api';

const REDIRECT_DELAY_MS = 2500;
const PROLIFIC_COMPLETION_URL = 'https://app.prolific.com/submissions/complete';
// Default Prolific "screen out / NOCODE" URL — used if you didn't configure
// PROLIFIC_SCREENOUT_CODE on the server.
const PROLIFIC_NOCODE_FALLBACK = `${PROLIFIC_COMPLETION_URL}?cc=NOCODE`;

export function ScreenOut() {
  const { sessionId, prolific, getExportData } = useWorkflowStore(
    useShallow(s => ({
      sessionId: s.sessionId,
      prolific: s.prolific,
      getExportData: s.getExportData,
    })),
  );

  const hasSaved = useRef(false);
  const [secondsLeft, setSecondsLeft] = useState(Math.ceil(REDIRECT_DELAY_MS / 1000));

  // Persist the partial response (including which attention check they failed)
  // before redirecting away. Researchers can audit screen-outs from this.
  useEffect(() => {
    if (hasSaved.current) return;
    hasSaved.current = true;
    const exportData = getExportData() as {
      userProfile: unknown;
      backgroundTranscript: unknown;
      selectedTasks: unknown;
      taskItems: unknown;
    };
    saveSession(
      sessionId,
      undefined,
      undefined,
      undefined,
      {
        screenedOut: true,
        screenOutReason: 'attention-check-failed',
        userProfile: exportData.userProfile,
        backgroundTranscript: exportData.backgroundTranscript,
        selectedTasks: exportData.selectedTasks,
        taskItems: exportData.taskItems,
        prolific,
      },
    ).catch(() => {});
  }, [sessionId, prolific, getExportData]);

  // Countdown + redirect.
  useEffect(() => {
    if (!prolific.pid) return; // local testing — don't auto-redirect
    const tick = setInterval(() => {
      setSecondsLeft((s) => Math.max(0, s - 1));
    }, 1000);
    const timer = setTimeout(() => {
      const code = prolific.screenOutCode;
      const url = code
        ? `${PROLIFIC_COMPLETION_URL}?cc=${encodeURIComponent(code)}`
        : PROLIFIC_NOCODE_FALLBACK;
      window.location.href = url;
    }, REDIRECT_DELAY_MS);
    return () => {
      clearInterval(tick);
      clearTimeout(timer);
    };
  }, [prolific.pid, prolific.screenOutCode]);

  const targetUrl = prolific.screenOutCode
    ? `${PROLIFIC_COMPLETION_URL}?cc=${encodeURIComponent(prolific.screenOutCode)}`
    : PROLIFIC_NOCODE_FALLBACK;

  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center px-8 py-16">
      <div className="absolute top-0 left-0 right-0 h-56 bg-gradient-to-b from-slate-50 to-transparent pointer-events-none" />

      <div className="relative max-w-md w-full text-center">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-slate-100 border border-slate-200 mb-7">
          <svg className="w-6 h-6 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>

        <h1 className="text-[1.6rem] font-light text-slate-800 leading-snug tracking-tight mb-3">
          Your responses don't qualify for this study.
        </h1>
        <p className="text-sm text-slate-500 leading-relaxed mb-8">
          Thanks for your time. You'll be returned to Prolific in <span className="font-semibold text-slate-700">{secondsLeft}s</span>.
        </p>

        {prolific.pid && (
          <a
            href={targetUrl}
            className="inline-block px-5 py-2.5 bg-slate-800 hover:bg-slate-900 text-white text-sm font-medium rounded-xl transition"
          >
            Return to Prolific now →
          </a>
        )}
      </div>
    </div>
  );
}
