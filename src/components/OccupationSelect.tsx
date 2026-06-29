import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useWorkflowStore } from "../store";
import { saveSession } from "../lib/api";
import type { OccupationCandidate } from "../types";

// O*NET-SOC definitions are written as verb-led duty sentences, so a single
// paragraph reads like a run-on task dump. Split on sentence boundaries so each
// card shows a short bullet list instead.
function definitionBullets(definition: string): string[] {
  return definition
    .split(/(?<=\.)\s+/)
    .map((s) => s.trim().replace(/\.$/, ""))
    .filter(Boolean);
}

// Occupation self-ID screen (shown right after the interview, before task
// selection): the participant picks the O*NET-SOC occupation they best identify
// with. The model suggests a ranked top-3 from their interview transcript; if none
// fit they can give a one-line hint and "show different options" (which excludes
// what they've already seen). The pick plus the full trail (sets shown, rejected
// codes, hints) is stored on the session.
export function OccupationSelect() {
  const { sessionId, backgroundTranscript, getExportData, setPhase, setOccupationSelection } =
    useWorkflowStore(
      useShallow((s) => ({
        sessionId: s.sessionId,
        backgroundTranscript: s.backgroundTranscript,
        getExportData: s.getExportData,
        setPhase: s.setPhase,
        setOccupationSelection: s.setOccupationSelection,
      })),
    );

  const [candidates, setCandidates] = useState<OccupationCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [hintText, setHintText] = useState("");
  const [mode, setMode] = useState<"candidates" | "search">("candidates");
  const [allOcc, setAllOcc] = useState<OccupationCandidate[]>([]);
  const [query, setQuery] = useState("");

  // Accumulated across "show different options" — persisted with the selection.
  const shownSets = useRef<OccupationCandidate[][]>([]);
  const rejectedCodes = useRef<string[]>([]);
  const hints = useRef<string[]>([]);

  async function fetchCandidates(excludeCodes: string[], hint: string) {
    setLoading(true);
    try {
      const res = await fetch("/api/occupation-candidates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backgroundTranscript, excludeCodes, hint }),
      });
      const data = await res.json();
      const cand: OccupationCandidate[] = Array.isArray(data.candidates) ? data.candidates : [];
      setCandidates(cand);
      if (cand.length) shownSets.current.push(cand);
      else { await ensureAllOcc(); setMode("search"); }   // fail-open → search
    } catch {
      setCandidates([]);
      await ensureAllOcc();
      setMode("search");
    } finally {
      setLoading(false);
      setHintText("");
    }
  }

  // Fetch candidates once on mount.
  useEffect(() => {
    fetchCandidates([], "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  function showDifferent() {
    rejectedCodes.current.push(...candidates.map((c) => c.code));
    const h = hintText.trim();
    if (h) hints.current.push(h);
    fetchCandidates(rejectedCodes.current.slice(), h);
  }

  async function choose(code: string, title: string, fromSearch: boolean) {
    if (submitting) return;
    setSubmitting(true);
    setOccupationSelection({
      selectedCode: code,
      selectedTitle: title,
      fromSearch,
      shownSets: shownSets.current,
      rejectedCodes: rejectedCodes.current,
      hints: hints.current,
      selectedAt: Date.now(),
    });
    try {
      await saveSession(sessionId, undefined, undefined, undefined, getExportData() as Record<string, unknown>);
    } catch {
      // Best-effort — proceed to task selection regardless.
    }
    setPhase("task-selection");
  }

  const filtered = query.trim()
    ? allOcc
        .filter((o) => `${o.title} ${o.code}`.toLowerCase().includes(query.trim().toLowerCase()))
        .slice(0, 60)
    : allOcc.slice(0, 60);

  // Loading state mirrors the study's other loaders: a bare centered loader with
  // a caption and NO heading/subcopy (those belong to the picked-screen content).
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
        <h1 className="text-[1.5rem] sm:text-[1.85rem] font-light text-slate-800 leading-snug tracking-tight mb-2">
          Which occupation best describes your work?
        </h1>
        <p className="text-sm text-slate-500 leading-relaxed mb-10">
          Based on your interview, here are the closest matches. Pick the one you most identify with.
        </p>

        {mode === "candidates" ? (
          <>
            <div className="mt-6 space-y-3">
              {candidates.slice(0, 3).map((c) => (
                <button
                  key={c.code}
                  type="button"
                  disabled={submitting}
                  onClick={() => choose(c.code, c.title, false)}
                  className="w-full text-left p-4 rounded-xl border border-slate-200 bg-white hover:border-indigo-400 hover:bg-indigo-50/40 transition disabled:opacity-60"
                >
                  <span className="block font-medium text-slate-800">{c.title}</span>
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
                Not quite right? Tell us what would fit better and we'll suggest others.
              </label>
              <input
                type="text"
                value={hintText}
                onChange={(e) => setHintText(e.target.value)}
                placeholder="e.g. more technical, I'm more of a manager, it's more creative"
                className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100"
              />
              <button
                type="button"
                onClick={showDifferent}
                className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium transition"
              >
                Show different options
              </button>
            </div>
          </>
        ) : (
          <div className="mt-6">
            <input
              type="text"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
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
                  className="w-full text-left px-4 py-2.5 rounded-lg border border-slate-200 bg-white hover:border-indigo-400 hover:bg-indigo-50/40 transition text-sm text-slate-700 disabled:opacity-60"
                >
                  {o.title}
                </button>
              ))}
              {!filtered.length && (
                <p className="text-sm text-slate-400 px-1 py-2">No matching occupations.</p>
              )}
            </div>
            {candidates.length > 0 && (
              <button
                type="button"
                onClick={() => { setMode("candidates"); setQuery(""); }}
                className="mt-4 text-sm font-medium text-indigo-600 hover:text-indigo-700"
              >
                ← Back to suggestions
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
