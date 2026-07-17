import { useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useWorkflowStore } from "../store";
import { saveSession, recordScreenOut, transcribeAudio } from "../lib/api";
import type { OccupationCandidate } from "../types";

type RecordState = "idle" | "recording" | "transcribing";

// The study only recruits these five occupations (U.S. BLS SOC codes). A
// participant who picks anything else is screened out here, at the occupation
// step, before the interview. Codes are matched exactly against the O*NET-SOC
// list (all five verified present in data/onet-soc.json).
const ELIGIBLE_SOCS = new Set<string>([
  "53-3032.00", // Heavy and Tractor-Trailer Truck Drivers
  "13-1031.00", // Claims Adjusters, Examiners, and Investigators
  "13-2011.00", // Accountants and Auditors
  "15-1299.09", // Information Technology Project Managers
  "29-1215.00", // Family Medicine Physicians
]);

// O*NET-SOC definitions are written as verb-led duty sentences, so a single
// paragraph reads like a run-on task dump. Split on sentence boundaries so each
// card shows a short bullet list instead.
function definitionBullets(definition: string): string[] {
  return definition
    .split(/(?<=\.)\s+/)
    .map((s) => s.trim().replace(/\.$/, ""))
    .filter(Boolean);
}

// SOC-FIRST variant of the occupation self-ID screen: shown at the START of the
// study (right after consent, BEFORE the interview) instead of after it. The
// participant types their job title / a short description; the model ranks the
// closest O*NET-SOC occupations from that text (there's no transcript yet). They
// pick the best fit; if none fit they can refine with a hint ("show different
// options", which excludes what they've seen) or free-search the full list. The
// study only recruits five occupations, so a pick outside that set is screened
// out here (before the interview). The pick + the full trail (the search query,
// sets shown, rejected codes, hints) is stored on the session, then the study
// proceeds to the interview.
export function OccupationSelect() {
  const {
    sessionId,
    getExportData,
    setPhase,
    setOccupationSelection,
    prolific,
    setProlific,
  } = useWorkflowStore(
    useShallow((s) => ({
      sessionId: s.sessionId,
      getExportData: s.getExportData,
      setPhase: s.setPhase,
      setOccupationSelection: s.setOccupationSelection,
      prolific: s.prolific,
      setProlific: s.setProlific,
    })),
  );

  // "query" = enter your title; "candidates" = ranked matches; "search" = plain
  // filter over the full SOC list.
  const [mode, setMode] = useState<"query" | "candidates" | "search">("query");
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<OccupationCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [hintText, setHintText] = useState("");
  const [allOcc, setAllOcc] = useState<OccupationCandidate[]>([]);
  const [filterQuery, setFilterQuery] = useState("");

  // Accumulated across "show different options" — persisted with the selection.
  const [shownSets, setShownSets] = useState<OccupationCandidate[][]>([]);
  const [rejectedCodes, setRejectedCodes] = useState<string[]>([]);
  const [hints, setHints] = useState<string[]>([]);

  // The job title / description the participant searched with — the sole basis
  // for the ranking (there's no interview transcript yet at this point).
  const searchQuery = query.trim();

  // Voice dictation for the query field — mirrors the interview recorder.
  // Transcribed text is appended so typing and speech can be mixed.
  const [recordState, setRecordState] = useState<RecordState>("idle");
  const [voiceError, setVoiceError] = useState("");
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

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
          setVoiceError("No audio captured — try again.");
          setRecordState("idle");
          return;
        }
        setRecordState("transcribing");
        try {
          const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
          const text = await transcribeAudio(blob);
          if (text.trim()) {
            setQuery((prev) => (prev ? prev + " " + text : text));
          } else {
            setVoiceError("Nothing was heard — try again.");
          }
        } catch (e) {
          console.error("Transcription failed", e);
          setVoiceError("Transcription failed — try again or type your answer.");
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

  async function fetchCandidates(excludeCodes: string[], hint: string) {
    setLoading(true);
    try {
      const res = await fetch("/api/occupation-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: searchQuery, excludeCodes, hint }),
      });
      const data = await res.json();
      const cand: OccupationCandidate[] = Array.isArray(data.candidates)
        ? data.candidates
        : [];
      setCandidates(cand);
      if (cand.length) {
        setShownSets((s) => [...s, cand]);
        setMode("candidates");
      } else {
        // Fail-open → let them free-search the full list.
        await ensureAllOcc();
        setMode("search");
      }
    } catch {
      setCandidates([]);
      await ensureAllOcc();
      setMode("search");
    } finally {
      setLoading(false);
      setHintText("");
    }
  }

  async function ensureAllOcc() {
    if (allOcc.length) return;
    try {
      const res = await fetch("/api/occupations");
      const data = await res.json();
      setAllOcc(Array.isArray(data.occupations) ? data.occupations : []);
    } catch {
      setAllOcc([]);
    }
  }

  function submitQuery() {
    if (!searchQuery || loading) return;
    fetchCandidates([], "");
  }

  function showDifferent() {
    const nextRejected = [...rejectedCodes, ...candidates.map((c) => c.code)];
    setRejectedCodes(nextRejected);
    const h = hintText.trim();
    if (h) setHints((hs) => [...hs, h]);
    fetchCandidates(nextRejected, h);
  }

  async function choose(code: string, title: string, fromSearch: boolean) {
    if (submitting) return;
    setSubmitting(true);
    // Record the pick regardless, so we keep a trail of what they selected even
    // when it's out of scope.
    setOccupationSelection({
      selectedCode: code,
      selectedTitle: title,
      fromSearch,
      query: searchQuery,
      shownSets,
      rejectedCodes,
      hints,
      selectedAt: Date.now(),
    });

    // Eligibility gate: the study only recruits the five target occupations.
    // A pick outside that set is screened out here, before the interview.
    const eligible = ELIGIBLE_SOCS.has(code);
    if (!eligible) {
      setProlific({
        screenedOut: true,
        screenOutReason: "occupation-not-eligible",
      });
      if (prolific.pid) {
        recordScreenOut(prolific.pid, sessionId, "occupation-not-eligible").catch(
          () => {},
        );
      }
    }
    try {
      await saveSession(
        sessionId,
        undefined,
        undefined,
        undefined,
        getExportData() as Record<string, unknown>,
      );
    } catch {
      // Best-effort — proceed regardless.
    }
    setPhase(eligible ? "background" : "screen-out");
  }

  const filtered = filterQuery.trim()
    ? allOcc
        .filter((o) =>
          `${o.title} ${o.code}`
            .toLowerCase()
            .includes(filterQuery.trim().toLowerCase()),
        )
        .slice(0, 60)
    : allOcc.slice(0, 60);

  // Loading state mirrors the study's other loaders: a bare centered loader with
  // a caption and NO heading/subcopy.
  if (loading) {
    return (
      <div className="min-h-screen bg-white flex flex-col items-center justify-center px-5 sm:px-8 py-12 sm:py-16">
        <div className="absolute top-0 left-0 right-0 h-56 bg-gradient-to-b from-indigo-50/30 to-transparent pointer-events-none" />
        <div className="relative flex flex-col items-center gap-5">
          <div className="flex gap-2">
            {[0, 150, 300].map((d) => (
              <span
                key={d}
                className="w-2 h-2 bg-indigo-300 rounded-full animate-bounce"
                style={{ animationDelay: `${d}ms` }}
              />
            ))}
          </div>
          <p className="text-slate-400 text-sm animate-fadeSlideIn">
            Finding the best matches…
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center px-5 sm:px-8 py-12 sm:py-16">
      <div className="absolute top-0 left-0 right-0 h-56 bg-gradient-to-b from-indigo-50/30 to-transparent pointer-events-none" />

      <div className="relative max-w-2xl w-full">
        {mode === "query" ? (
          <>
            <h1 className="text-[1.5rem] sm:text-[1.85rem] font-light text-slate-800 leading-snug tracking-tight mb-2">
              Let's start with your occupation.
            </h1>
            <p className="text-sm text-slate-500 leading-relaxed mb-8">
              We recruit specific occupations, so we'll check whether yours is
              eligible.
            </p>

            <div className="relative">
              <textarea
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submitQuery();
                  }
                }}
                rows={3}
                disabled={recordState === "transcribing"}
                placeholder={
                  recordState === "recording"
                    ? "Recording — click the mic again to stop"
                    : recordState === "transcribing"
                      ? "Transcribing…"
                      : "Describe what you do at work in 1-2 sentences"
                }
                className="w-full rounded-xl border border-slate-200 bg-white pl-3.5 pr-14 py-3 text-sm text-slate-800 placeholder:text-slate-400 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100 resize-none disabled:opacity-60"
              />
              <button
                type="button"
                onClick={toggleRecording}
                disabled={recordState === "transcribing"}
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
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none">
                    <rect x="9" y="2" width="6" height="12" rx="3" fill="currentColor" />
                    <path
                      d="M5 10a7 7 0 0 0 14 0"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      fill="none"
                    />
                    <line x1="12" y1="19" x2="12" y2="22" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                    <line x1="9" y1="22" x2="15" y2="22" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                )}
              </button>
            </div>
            {voiceError && (
              <p className="mt-2 text-sm text-amber-600">{voiceError}</p>
            )}

            <div className="mt-5 flex items-center gap-4">
              <button
                type="button"
                onClick={submitQuery}
                disabled={!searchQuery}
                className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white text-sm font-medium transition"
              >
                Find matches
              </button>
              <button
                type="button"
                onClick={async () => {
                  await ensureAllOcc();
                  setMode("search");
                }}
                className="text-sm text-slate-400 hover:text-indigo-600 transition"
              >
                or search all occupations
              </button>
            </div>
          </>
        ) : mode === "candidates" ? (
          <>
            <h1 className="text-[1.5rem] sm:text-[1.85rem] font-light text-slate-800 leading-snug tracking-tight mb-2">
              Which occupation best describes your work?
            </h1>
            <p className="text-sm text-slate-500 leading-relaxed mb-10">
              Here are the closest matches. Pick the one you most identify with.
            </p>

            <div className="mt-6 space-y-3">
              {candidates.slice(0, 3).map((c) => (
                <button
                  key={c.code}
                  type="button"
                  disabled={submitting}
                  onClick={() => choose(c.code, c.title, false)}
                  className="w-full text-left p-4 rounded-xl border border-slate-200 bg-white hover:border-indigo-400 hover:bg-indigo-50/40 transition disabled:opacity-60"
                >
                  <span className="block font-medium text-slate-800">
                    {c.title}
                  </span>
                  {c.definition && (
                    <ul className="mt-2 list-disc pl-4 space-y-1 text-xs text-slate-500 leading-relaxed">
                      {definitionBullets(c.definition).map((b, i) => (
                        <li key={i}>{b}</li>
                      ))}
                    </ul>
                  )}
                </button>
              ))}
            </div>

            <div className="mt-6 border-t border-slate-100 pt-5 space-y-3">
              <label className="block text-sm font-medium text-slate-700">
                Not quite right? Tell us what would fit better and we'll suggest
                others.
              </label>
              <input
                type="text"
                value={hintText}
                onChange={(e) => setHintText(e.target.value)}
                placeholder="e.g. more technical, I'm more of a manager, it's more creative"
                className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100"
              />
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={showDifferent}
                  className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium transition"
                >
                  Show different options
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    await ensureAllOcc();
                    setMode("search");
                  }}
                  className="text-sm text-slate-400 hover:text-indigo-600 transition"
                >
                  or search all occupations
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <h1 className="text-[1.5rem] sm:text-[1.85rem] font-light text-slate-800 leading-snug tracking-tight mb-2">
              Search for your occupation
            </h1>
            <p className="text-sm text-slate-500 leading-relaxed mb-8">
              Find the official occupation that best matches your title and job.
            </p>
            <input
              type="text"
              autoFocus
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              placeholder="Search all occupations…"
              className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100"
            />
            <div className="mt-3 max-h-[55vh] overflow-y-auto space-y-1.5">
              {filtered.map((o) => (
                <button
                  key={o.code}
                  type="button"
                  disabled={submitting}
                  onClick={() => choose(o.code, o.title, true)}
                  className="w-full text-left px-4 py-2.5 rounded-lg border border-slate-200 bg-white hover:border-indigo-400 hover:bg-indigo-50/40 transition disabled:opacity-60"
                >
                  <span className="block text-sm font-medium text-slate-700">
                    {o.title}
                  </span>
                  {o.definition && (
                    <ul className="mt-1.5 list-disc pl-4 space-y-1 text-xs text-slate-500 leading-relaxed">
                      {definitionBullets(o.definition).map((b, i) => (
                        <li key={i}>{b}</li>
                      ))}
                    </ul>
                  )}
                </button>
              ))}
              {!filtered.length && (
                <p className="text-sm text-slate-400 px-1 py-2">
                  No matching occupations.
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() =>
                candidates.length > 0 ? setMode("candidates") : setMode("query")
              }
              className="mt-4 text-sm font-medium text-indigo-600 hover:text-indigo-700"
            >
              {candidates.length > 0 ? "← Back to suggestions" : "← Back"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
