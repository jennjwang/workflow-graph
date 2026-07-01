import { useEffect, useRef, useState } from "react";

// Occupation self-ID for the validation studies. Self-contained (no interview
// store/phase machine): fed by the screener's duties text, it fetches a ranked
// top-3 O*NET-SOC shortlist from /api/occupation-candidates, lets the participant
// pick one (with "show different options" and a full-catalog search fallback via
// /api/occupations), and hands the pick + trail back through onSelect. It is
// purely informational — it does NOT change which task inventory is assigned.

export interface OccupationCandidate {
  code: string;
  title: string;
  definition?: string;
  why?: string;
}

export interface OccupationPick {
  selectedCode: string;
  selectedTitle: string;
  fromSearch: boolean;
  shownSets: OccupationCandidate[][];
  rejectedCodes: string[];
  hints: string[];
}

// O*NET-SOC definitions are verb-led duty sentences; split on sentence
// boundaries so each card shows a short bullet list instead of a run-on.
function definitionBullets(definition: string): string[] {
  return definition
    .split(/(?<=\.)\s+/)
    .map((s) => s.trim().replace(/\.$/, ""))
    .filter(Boolean);
}

export function ValidationOccupationSelect({
  title,
  duties,
  onSelect,
}: {
  title: string;
  duties: string;
  onSelect: (pick: OccupationPick) => void;
}) {
  const [candidates, setCandidates] = useState<OccupationCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [hintText, setHintText] = useState("");
  const [mode, setMode] = useState<"candidates" | "search">("candidates");
  const [allOcc, setAllOcc] = useState<OccupationCandidate[]>([]);
  const [query, setQuery] = useState("");

  // Accumulated across "show different options" — passed back with the pick.
  const shownSets = useRef<OccupationCandidate[][]>([]);
  const rejectedCodes = useRef<string[]>([]);
  const hints = useRef<string[]>([]);

  // The screener answers become a one-item transcript for the candidate model.
  const transcript = [
    { question: "What's your current job title?", answer: title },
    { question: "What do you do day-to-day?", answer: duties },
  ];

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

  async function fetchCandidates(excludeCodes: string[], hint: string) {
    setLoading(true);
    try {
      const res = await fetch("/api/occupation-candidates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          backgroundTranscript: transcript,
          excludeCodes,
          hint,
        }),
      });
      const data = await res.json();
      const cand: OccupationCandidate[] = Array.isArray(data.candidates)
        ? data.candidates
        : [];
      setCandidates(cand);
      if (cand.length) shownSets.current.push(cand);
      else {
        await ensureAllOcc();
        setMode("search");
      } // fail-open → search
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

  function showDifferent() {
    rejectedCodes.current.push(...candidates.map((c) => c.code));
    const h = hintText.trim();
    if (h) hints.current.push(h);
    fetchCandidates(rejectedCodes.current.slice(), h);
  }

  function choose(code: string, occTitle: string, fromSearch: boolean) {
    if (submitting) return;
    setSubmitting(true);
    onSelect({
      selectedCode: code,
      selectedTitle: occTitle,
      fromSearch,
      shownSets: shownSets.current,
      rejectedCodes: rejectedCodes.current,
      hints: hints.current,
    });
  }

  const filtered = query.trim()
    ? allOcc
        .filter((o) =>
          `${o.title} ${o.code}`
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
        )
        .slice(0, 60)
    : allOcc.slice(0, 60);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="flex flex-col items-center gap-5">
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
    <div className="flex h-full items-center justify-center px-6 py-10 overflow-y-auto">
      <div className="w-full max-w-xl animate-fadeSlideIn">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-indigo-400">
          Before we begin
        </p>
        <h1 className="mt-4 text-2xl font-light text-slate-800 leading-snug">
          Which occupation best describes your work?
        </h1>
        <p className="mt-2 text-sm text-slate-500 leading-relaxed">
          Based on what you told us, here are the closest matches. Pick the one
          you most identify with.
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
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 pt-1">
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
                  className="text-sm font-medium text-indigo-600 hover:text-indigo-700"
                >
                  Search all occupations →
                </button>
              </div>
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
                <p className="text-sm text-slate-400 px-1 py-2">
                  No matching occupations.
                </p>
              )}
            </div>
            {candidates.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setMode("candidates");
                  setQuery("");
                }}
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
