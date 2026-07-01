import { useRef, useState } from "react";
import { verifyOccupation } from "../../lib/validation/screenerApi";
import { transcribeAudio } from "../../lib/validation/voiceApi";

type RecordState = "idle" | "recording" | "transcribing";

// Shared occupation screener UI. Collects job title + day-to-day duties, runs the
// server-side classification, and calls back on the outcome. The target
// occupation is never shown (placeholders use an unrelated occupation so they
// don't cue the answer). Renders inner content only — wrap in a study's Frame.

export function OccupationScreener({
  externalId,
  onPass,
  onFail,
  onError,
  verify = true,
}: {
  externalId: string;
  onPass: (info: { title: string; duties: string }) => void; // verified match — caller proceeds
  onFail?: () => void; // non-match — caller shows the screen-out (only when verify)
  onError?: (msg: string) => void;
  verify?: boolean; // when false, collect title+duties without the hidden-target gate
}) {
  const [title, setTitle] = useState("");
  const [duties, setDuties] = useState("");
  const [busy, setBusy] = useState(false);
  const [retryNote, setRetryNote] = useState("");
  const [recordState, setRecordState] = useState<RecordState>("idle");
  const [voiceError, setVoiceError] = useState("");
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  const canVerify = title.trim().length > 0 && duties.trim().length >= 3;

  // Voice dictation for the duties field — transcribed text is appended so the
  // participant can mix typing and speech. Mirrors the interview app's recorder.
  const toggleRecording = async () => {
    if (busy) return;
    if (recordState === "recording") {
      mediaRecorderRef.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunksRef.current = [];
      const mimeType =
        [
          "audio/webm;codecs=opus",
          "audio/webm",
          "audio/ogg;codecs=opus",
          "audio/mp4",
        ].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const chunks = audioChunksRef.current;
        if (chunks.length === 0) {
          setVoiceError("No audio captured — try again.");
          setRecordState("idle");
          return;
        }
        setRecordState("transcribing");
        try {
          const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
          const text = await transcribeAudio(blob);
          if (text.trim()) {
            setDuties((prev) => (prev ? prev + " " + text : text));
          } else {
            setVoiceError("Nothing was heard — try again.");
          }
        } catch (e) {
          console.error("Transcription failed", e);
          setVoiceError(
            "Transcription failed — try again or type your answer.",
          );
        } finally {
          setRecordState("idle");
        }
      };
      recorder.start(250); // 250ms timeslice ensures data flows reliably
      setVoiceError("");
      setRecordState("recording");
    } catch (e) {
      console.error("Mic access denied", e);
      setVoiceError("Microphone access denied — please allow mic permissions.");
    }
  };

  const submit = async () => {
    if (!canVerify || busy) return;
    // No-gate mode: just hand the answers up (a later step does the screening).
    if (!verify) {
      onPass({ title: title.trim(), duties: duties.trim() });
      return;
    }
    setRetryNote("");
    setBusy(true);
    try {
      const v = await verifyOccupation(externalId, title.trim(), duties.trim());
      if (v.match) onPass({ title: title.trim(), duties: duties.trim() });
      else onFail?.();
      return; // leave busy set — the caller unmounts this screen
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      if (msg === "RETRY") {
        setRetryNote("We couldn't check that just now. Please try again.");
      } else {
        onError?.(msg);
      }
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="w-full max-w-xl animate-fadeSlideIn">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-indigo-400">
          Before we begin
        </p>
        <h1 className="mt-4 text-2xl font-light text-slate-800 leading-snug">
          What's your current job?
        </h1>

        <label className="mt-6 block text-sm font-medium text-slate-700">
          Your job title
        </label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={busy}
          placeholder="e.g. Registered Nurse"
          className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 transition focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-60"
        />

        <label className="mt-5 block text-sm font-medium text-slate-700">
          What do you do day-to-day?
        </label>
        <p className="mt-1 text-xs text-slate-400 leading-relaxed">
          Describe your main responsibilities and the work you spend the most
          time on — this matters more than the title.
        </p>
        <div className="mt-2 relative">
          <textarea
            value={duties}
            onChange={(e) => setDuties(e.target.value)}
            rows={4}
            disabled={busy || recordState === "transcribing"}
            placeholder={
              recordState === "recording"
                ? "Recording — click the mic again to stop"
                : recordState === "transcribing"
                  ? "Transcribing…"
                  : "e.g. I care for patients on a hospital ward, give medications, monitor vitals, and coordinate with doctors on treatment plans. Or use the mic to dictate."
            }
            className="w-full pl-4 pr-14 py-3 text-sm text-slate-800 leading-relaxed placeholder:text-slate-400 bg-white border border-slate-200 rounded-xl transition focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-200 resize-none disabled:opacity-60"
          />
          <button
            type="button"
            onClick={toggleRecording}
            disabled={busy || recordState === "transcribing"}
            aria-label={
              recordState === "recording" ? "Stop recording" : "Record audio"
            }
            title={
              recordState === "recording" ? "Stop recording" : "Record audio"
            }
            className={`absolute right-2.5 bottom-2.5 w-9 h-9 rounded-full flex items-center justify-center transition active:scale-[0.95] disabled:cursor-not-allowed
              ${
                recordState === "recording"
                  ? "bg-red-500 text-white shadow-sm shadow-red-200"
                  : recordState === "transcribing"
                    ? "bg-slate-100 text-slate-300"
                    : "bg-indigo-50 text-indigo-600 hover:bg-indigo-100 hover:text-indigo-700"
              }`}
          >
            {recordState === "transcribing" ? (
              <div className="flex items-center justify-center gap-[2px] h-5">
                {[0, 120, 240, 360].map((delay, i) => (
                  <span
                    key={i}
                    className="w-[2px] h-4 bg-indigo-500 rounded-full animate-waveBar"
                    style={{ animationDelay: `${delay}ms` }}
                  />
                ))}
              </div>
            ) : recordState === "recording" ? (
              <svg
                className="w-3.5 h-3.5"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            ) : (
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none">
                <rect
                  x="9"
                  y="2"
                  width="6"
                  height="12"
                  rx="3"
                  fill="currentColor"
                />
                <path
                  d="M5 10a7 7 0 0 0 14 0"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  fill="none"
                />
                <line
                  x1="12"
                  y1="19"
                  x2="12"
                  y2="22"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
                <line
                  x1="9"
                  y1="22"
                  x2="15"
                  y2="22"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            )}
          </button>
        </div>
        {voiceError && (
          <p className="mt-2 text-sm text-amber-600">{voiceError}</p>
        )}
        {retryNote && (
          <p className="mt-2 text-sm text-amber-600">{retryNote}</p>
        )}
        <div className="mt-6 flex justify-end">
          <button
            onClick={submit}
            disabled={!canVerify || busy}
            className="inline-flex items-center gap-2 px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-30 disabled:cursor-not-allowed text-white text-sm font-medium rounded-full transition-all active:scale-[0.98] shadow-sm shadow-indigo-200"
          >
            {busy ? "Checking…" : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}
