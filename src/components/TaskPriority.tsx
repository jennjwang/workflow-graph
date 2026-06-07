import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useWorkflowStore } from "../store";

const MIN_PICKS = 1;

// Dev shortcut: ?dev=task-priority&review=1 seeds a few tasks so the page
// renders with content when there's no real session behind it.
const DEV_SEED_TASKS = [
  "Read recent conference papers",
  "Debug research code",
  "Meet with my advisor",
  "Draft a paper section",
  "Present updates at lab meeting",
  "Mentor undergraduate researchers",
  "Prepare figures for a manuscript",
];

// Fisher-Yates shuffle; keeps the source array intact.
function shuffled<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function TaskPriority() {
  const {
    selectedTasks,
    interviewExtractedTasks,
    setPhase,
    setCoreTask,
    setSelectedTasks,
  } = useWorkflowStore(
    useShallow((s) => ({
      selectedTasks: s.selectedTasks,
      interviewExtractedTasks: s.interviewExtractedTasks,
      setPhase: s.setPhase,
      setCoreTask: s.setCoreTask,
      setSelectedTasks: s.setSelectedTasks,
    })),
  );

  // Pool the participant's confirmed tasks with the activities extracted from
  // the background interview so anything they explicitly described shows up
  // here even if it didn't make it through the Part 2 confirm flow. Dedup is
  // case-insensitive + trim-aware to absorb minor wording drift between the
  // interview wording and the generated task name.
  const mergedTasks = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of [...selectedTasks, ...interviewExtractedTasks]) {
      const key = t.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
    return out;
  }, [selectedTasks, interviewExtractedTasks]);

  // In review mode with no real tasks, fall back to a seed so the page is
  // viewable. Memoized so the shuffle below stays stable across renders.
  const effectiveTasks = useMemo(() => {
    const reviewMode =
      new URLSearchParams(window.location.search).get("review") === "1";
    return reviewMode && mergedTasks.length === 0 ? DEV_SEED_TASKS : mergedTasks;
  }, [mergedTasks]);

  // Shuffle once per mount so participants don't anchor on the first task in
  // the original (TaskSelection) ordering. The canonical store order is left
  // intact so submit can preserve it for the picked subset.
  const displayTasks = useMemo(() => shuffled(effectiveTasks), [effectiveTasks]);

  const [picked, setPicked] = useState<Set<string>>(new Set());

  const togglePick = (task: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(task)) next.delete(task);
      else next.add(task);
      return next;
    });
  };

  const canContinue = picked.size >= MIN_PICKS;

  const handleContinue = () => {
    if (!canContinue) return;
    // Preserve the merged-pool order (selectedTasks first, then interview-only
    // extras) so the mapping loop visits picks in the same order shown here.
    const ordered = effectiveTasks.filter((t) => picked.has(t));
    setSelectedTasks(ordered);
    setCoreTask(ordered[0]);
    setPhase("workflow-kickoff");
  };

  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center px-8 py-16">
      <div className="absolute top-0 left-0 right-0 h-56 bg-gradient-to-b from-indigo-50/30 to-transparent pointer-events-none" />

      <div className="relative max-w-5xl w-full">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-indigo-400 mb-8">
          Part 3 of 3 — Task Decomposition
        </p>

        <h1 className="text-[1.85rem] font-light text-slate-800 leading-snug tracking-tight mb-3">
          Which tasks are most essential to your work?
        </h1>
        <p className="text-sm text-slate-400 mb-10">
          We'll dig into just one of these tasks in depth next.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 mb-10">
          {displayTasks.map((task, i) => {
            const letter = String.fromCharCode(65 + i);
            const isSelected = picked.has(task);
            return (
              <button
                key={task}
                onClick={() => togglePick(task)}
                className={`
                  group flex items-start gap-3.5 w-full px-4 py-3.5 rounded-2xl border text-left
                  transition-all duration-150 active:scale-[0.99]
                  ${
                    isSelected
                      ? "border-indigo-400 bg-indigo-50"
                      : "border-slate-200/70 hover:border-indigo-300 hover:bg-indigo-50/50 bg-white"
                  }
                `}
              >
                <span
                  className={`
                  flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-xs font-semibold border mt-0.5
                  transition-all duration-150
                  ${
                    isSelected
                      ? "bg-indigo-500 border-indigo-500 text-white"
                      : "border-slate-200 text-slate-400 group-hover:bg-indigo-500 group-hover:border-indigo-500 group-hover:text-white"
                  }
                `}
                >
                  {letter}
                </span>
                <span
                  className={`text-sm font-medium leading-snug flex-1 ${isSelected ? "text-indigo-800" : "text-slate-700"}`}
                >
                  {task}
                </span>
                {isSelected && (
                  <svg
                    className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>

        <div className="flex items-center justify-between">
          <span className="text-sm text-slate-400">
            {picked.size === 0
              ? `Pick at least one task to map`
              : `${picked.size} task${picked.size === 1 ? "" : "s"} selected`}
          </span>
          <button
            onClick={handleContinue}
            disabled={!canContinue}
            className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-30 disabled:cursor-not-allowed
                       text-white px-6 py-2.5 rounded-xl text-sm font-medium transition-all"
          >
            Continue →
          </button>
        </div>
      </div>
    </div>
  );
}
