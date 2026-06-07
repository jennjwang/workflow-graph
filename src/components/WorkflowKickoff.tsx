import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useWorkflowStore } from "../store";
import { transcribeAudio, fetchKickoffQuestion } from "../lib/api";
import {
  BONUS_ENABLED,
  MAPPING_EDIT_BONUS_PER_CHAR_USD,
  MAPPING_EDIT_BONUS_MAX_USD,
  MAPPING_ADD_NODE_BONUS_USD,
  MAPPING_ADD_NODE_BONUS_MAX_USD,
  formatUsd,
} from "../lib/bonus";

type RecordState = "idle" | "recording" | "transcribing";

function MicOrb({
  state,
  onToggle,
  disabled,
}: {
  state: RecordState;
  onToggle: () => void;
  disabled: boolean;
}) {
  const isRecording = state === "recording";
  const isTranscribing = state === "transcribing";
  return (
    <div className="flex flex-col items-center gap-3 select-none">
      <div className="relative flex items-center justify-center">
        {isRecording && (
          <>
            <span className="absolute w-36 h-36 rounded-full bg-indigo-100 animate-ping opacity-30" />
            <span className="absolute w-28 h-28 rounded-full bg-indigo-100 animate-ping opacity-50 [animation-delay:250ms]" />
          </>
        )}
        <button
          type="button"
          onClick={onToggle}
          disabled={disabled || isTranscribing}
          className={`
            relative z-10 w-20 h-20 rounded-full flex items-center justify-center
            transition-all duration-200
            ${
              isRecording
                ? "bg-red-500 shadow-lg shadow-red-200 scale-105"
                : isTranscribing
                  ? "bg-indigo-100 cursor-not-allowed"
                  : "bg-indigo-50 hover:bg-indigo-100 hover:scale-105 active:scale-95 shadow-sm"
            }
            disabled:opacity-50
          `}
        >
          {isTranscribing ? (
            <svg
              className="w-7 h-7 text-indigo-400 animate-spin"
              viewBox="0 0 24 24"
              fill="none"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="3"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8v8z"
              />
            </svg>
          ) : isRecording ? (
            <svg
              className="w-6 h-6 text-white"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          ) : (
            <svg
              className="w-8 h-8 text-indigo-600"
              viewBox="0 0 24 24"
              fill="none"
            >
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
      <span
        className={`text-sm font-medium tracking-wide transition-colors ${
          isRecording
            ? "text-red-500"
            : isTranscribing
              ? "text-indigo-400"
              : "text-indigo-600"
        }`}
      >
        {isRecording
          ? "Recording — click to stop"
          : isTranscribing
            ? "Transcribing…"
            : "Start Recording"}
      </span>
    </div>
  );
}

export function WorkflowKickoff() {
  const { coreTask, addMessage, setPhase, setCoreTaskShort, currentTaskIdx } = useWorkflowStore(
    useShallow((s) => ({
      coreTask: s.coreTask,
      addMessage: s.addMessage,
      setPhase: s.setPhase,
      setCoreTaskShort: s.setCoreTaskShort,
      currentTaskIdx: s.currentTaskIdx,
    })),
  );

  // AI-generated to handle both short labels ("Implement ticket changes") and
  // multi-sentence edited descriptions gracefully. Returns a short canvas label
  // too so the mapping phase shows a concise title instead of the full prose.
  // Falls back to a static statement if the server call errors.
  const [question, setQuestion] = useState<string | null>(null);
  const fetchedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!coreTask || fetchedFor.current === coreTask) return;
    fetchedFor.current = coreTask;
    fetchKickoffQuestion(coreTask)
      .then(({ question: q, shortLabel }) => {
        setQuestion(q);
        setCoreTaskShort(shortLabel);
      })
      .catch((err) => {
        console.error("[kickoff] fetchKickoffQuestion failed:", err);
        setQuestion(`Walk me through how you do this task: ${coreTask}`);
        setCoreTaskShort(coreTask);
      });
  }, [coreTask, setCoreTaskShort]);

  const [answer, setAnswer] = useState("");
  const [showTextInput, setShowTextInput] = useState(false);
  const [recordState, setRecordState] = useState<RecordState>("idle");
  // Show the framing/instructions card BEFORE the walkthrough question so the
  // participant knows what they're about to do. The kickoff question fetch
  // above fires in parallel, so by the time they click Continue the question
  // is usually ready. Skipped for tasks 2+ — the participant already knows the
  // drill by then; "Next task →" should land them straight on the question.
  const [showIntro, setShowIntro] = useState(currentTaskIdx === 0);
  const inputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  const submit = (text: string) => {
    const content = text.trim();
    if (!content || !question) return;
    addMessage("assistant", question);
    addMessage("user", content);
    setPhase("workflow");
  };

  const toggleRecording = async () => {
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
          setRecordState("idle");
          return;
        }
        setRecordState("transcribing");
        try {
          const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
          const text = await transcribeAudio(blob);
          if (text.trim()) {
            setAnswer((prev) => (prev ? prev + " " + text : text));
            setShowTextInput(true);
            setTimeout(() => inputRef.current?.focus(), 50);
          }
        } catch (e) {
          console.error("Transcription failed", e);
        } finally {
          setRecordState("idle");
        }
      };
      recorder.start(250);
      setRecordState("recording");
    } catch (e) {
      console.error("Mic access denied", e);
    }
  };

  if (showIntro) {
    return (
      <div className="min-h-screen bg-white flex flex-col items-center justify-center px-8 py-16 relative">
        <div className="absolute top-0 left-0 right-0 h-56 bg-gradient-to-b from-indigo-50/30 to-transparent pointer-events-none" />

        <div className="relative max-w-2xl w-full">
          <p
            className="text-[10px] font-semibold uppercase tracking-[0.18em] text-indigo-400 mb-9 animate-fadeSlideUp"
            style={{ animationDelay: "0ms" }}
          >
            Part 3 of 3 — Task Decomposition
          </p>
          <h2
            className="text-[1.65rem] font-light text-slate-800 leading-snug tracking-tight animate-fadeSlideUp"
            style={{ animationDelay: "80ms" }}
          >
            Now let's map out the tasks step by step.
          </h2>
          <p
            className="text-slate-500 mt-6 text-[15px] leading-[1.7] animate-fadeSlideUp"
            style={{ animationDelay: "160ms" }}
          >
            For each essential task, we'll first ask you to walk us through how
            you do it. Then the AI proposes a set of subtasks for that task, and
            you confirm, rename, discard, or add until the map matches how you
            really work.
          </p>
          {BONUS_ENABLED && (
            <div className="mt-10 space-y-4">
              <div
                className="px-5 py-4 rounded-xl border border-amber-200 bg-amber-50 animate-fadeSlideUp"
                style={{ animationDelay: "240ms" }}
              >
                <div className="text-sm leading-[1.6]">
                  <p className="font-semibold text-amber-700 mb-1.5">Bonus</p>
                  <p className="text-slate-700">
                    Edit an AI-suggested task, or add your own subtasks. We'll
                    give you a bonus for each edit you make and for every subtask
                    you add.
                  </p>
                  <p className="mt-2.5 text-amber-800">
                    <span className="font-semibold">
                      {formatUsd(MAPPING_EDIT_BONUS_PER_CHAR_USD * 1000)} per
                      1,000 characters
                    </span>{" "}
                    edited (up to {formatUsd(MAPPING_EDIT_BONUS_MAX_USD)}), plus{" "}
                    <span className="font-semibold">
                      {formatUsd(MAPPING_ADD_NODE_BONUS_USD)} per subtask added
                    </span>{" "}
                    (up to {formatUsd(MAPPING_ADD_NODE_BONUS_MAX_USD)}).
                  </p>
                </div>
              </div>
            </div>
          )}
          <button
            onClick={() => setShowIntro(false)}
            className="mt-14 inline-flex items-center gap-2 px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-full transition-all active:scale-[0.98] shadow-sm shadow-indigo-200 animate-fadeSlideUp"
            style={{ animationDelay: "320ms" }}
          >
            Continue
            <svg
              className="w-4 h-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="13 6 19 12 13 18" />
            </svg>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center px-8 py-16 relative">
      <div className="absolute top-0 left-0 right-0 h-56 bg-gradient-to-b from-indigo-50/30 to-transparent pointer-events-none" />

      <div className="relative max-w-3xl w-full">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-indigo-400 mb-8">
          Part 3 of 3 — Task Decomposition
        </p>

        {question ? (
          <h1 className="text-[1.85rem] font-light text-slate-800 leading-snug tracking-tight mb-14">
            {question}
          </h1>
        ) : (
          <div className="mb-14 flex items-center gap-2 text-slate-400">
            <span className="flex gap-1.5">
              {[0, 150, 300].map((d) => (
                <span
                  key={d}
                  className="w-1.5 h-1.5 bg-indigo-300 rounded-full animate-bounce"
                  style={{ animationDelay: `${d}ms` }}
                />
              ))}
            </span>
            <span className="text-sm">Reviewing your task…</span>
          </div>
        )}

        {question && !showTextInput && (
          <div className="flex flex-col items-center gap-6 mb-8">
            <MicOrb
              state={recordState}
              onToggle={toggleRecording}
              disabled={false}
            />
            <button
              onClick={() => {
                setShowTextInput(true);
                setTimeout(() => inputRef.current?.focus(), 50);
              }}
              className="text-xs text-slate-400 hover:text-indigo-500 transition"
            >
              Prefer to type? →
            </button>
          </div>
        )}

        {question && showTextInput && (
          <div className="space-y-3">
            <textarea
              ref={inputRef as unknown as React.RefObject<HTMLTextAreaElement>}
              autoFocus
              rows={4}
              className="w-full border border-slate-200 rounded-2xl px-5 py-4 text-sm text-slate-800
                         placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-300
                         focus:border-transparent bg-white transition-all resize-none leading-relaxed"
              placeholder="Describe the steps you take…"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && e.metaKey) submit(answer);
              }}
            />
            <div className="flex items-center justify-between">
              <p className="text-[11px] text-slate-400">
                <kbd className="bg-slate-100 px-1.5 py-0.5 rounded text-[10px] font-mono text-slate-500 mr-1">
                  ⌘ Enter
                </kbd>
                to submit
              </p>
              <button
                onClick={() => submit(answer)}
                disabled={!answer.trim()}
                className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-30 text-white px-6 py-2.5
                           rounded-xl text-sm font-medium transition-all"
              >
                Continue →
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
