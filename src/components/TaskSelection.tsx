import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  generateTasksFromInterview,
  extractInterviewTasks,
  recordScreenOut,
  transcribeAudio,
  postTaskResponse,
} from "../lib/api";
import { useWorkflowStore } from "../store";
import { BONUS_ENABLED } from "../lib/bonus";
import { TaskItem } from "../types";

// Master switch for the hours feature: the per-task "how many hours" question
// AND the "Your week at a glance" summary screen. Flip to false to drop both —
// the flow then goes review/add → finalize with no hours collected.
const HOURS_ENABLED = false;

// Hard cap on the picker list (real tasks + spliced attention checks). Also
// the progress-bar denominator so the bar reflects actual rating progress.
const MAX_TASKS = 20;

// Number of tasks the participant must rate before the "Finish early"
// affordance unlocks. Pinned to MAX_TASKS so the threshold tracks the picker
// cap — finishing early now means "after the full list".
const DONE_THRESHOLD = MAX_TASKS;

// The "Make it yours" edit nudge stays hidden until the participant has passed
// this many task cards without editing any task name. Once they edit any task,
// the nudge stops appearing for the rest of the flow.
const NUDGE_AFTER_UNEDITED = 3;


// Three separate bonus pools:
//  • EDIT bonus:    per-character on tasks the participant rewords (Levenshtein distance).
//  • ADD  bonus:    flat per-task on tasks the participant types in on the all-done screen.
//  • AI-USE bonus:  per-character on the "how do you use AI?" description for each task.
const EDIT_BONUS_PER_CHAR_USD = 0.001;
const EDIT_BONUS_MAX_USD = 1.5;
const ADD_BONUS_PER_TASK_USD = 0.05;
const ADD_BONUS_MAX_USD = 1.0;
const AI_HOWSO_BONUS_PER_CHAR_USD = 0.001;
const AI_HOWSO_BONUS_MAX_USD = 1.0;

// Levenshtein distance — counts insertions, deletions, AND substitutions, so
// rewriting "Review code" → "Review pull requests" credits the real edit work.
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m = a.length,
    n = b.length;
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1, // insertion
        prev[j] + 1, // deletion
        prev[j - 1] + cost, // substitution
      );
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

function totalEditChars(tasks: TaskItem[]): number {
  return tasks.reduce((sum, t) => {
    if (t.isAttentionCheck) return sum;
    return (
      sum + (t.status === "edited" ? levenshtein(t.originalName, t.name) : 0)
    );
  }, 0);
}

function formatUsd(n: number) {
  return `$${n.toFixed(2)}`;
}

// ── Main component ─────────────────────────────────────────────────────────────

export function TaskSelection() {
  const {
    userProfile,
    backgroundTranscript,
    interviewExtractedTasks,
    setSelectedTasks,
    setTaskItems,
    setBonusSnapshot,
    setInterviewExtractedTasks,
    setPhase,
    prolific,
    setProlific,
    condition,
  } = useWorkflowStore(
    useShallow((s) => ({
      userProfile: s.userProfile,
      backgroundTranscript: s.backgroundTranscript,
      interviewExtractedTasks: s.interviewExtractedTasks,
      setSelectedTasks: s.setSelectedTasks,
      setTaskItems: s.setTaskItems,
      setBonusSnapshot: s.setBonusSnapshot,
      setInterviewExtractedTasks: s.setInterviewExtractedTasks,
      setPhase: s.setPhase,
      prolific: s.prolific,
      setProlific: s.setProlific,
      condition: s.condition,
    })),
  );
  const totalParts = condition === "short" ? 2 : 3;

  // Dev shortcut: ?dev=task-selection&review=1 jumps straight to the
  // "What else fills your week?" review screen with seeded confirmed tasks.
  // ?dev=task-selection&card=1 instead lands on the single per-task review card
  // (the confirm/edit/AI-use step) with seeded unreviewed tasks to click through.
  // ?dev=task-selection&hours=1 lands on the "Your week at a glance" hours
  // summary with seeded confirmed tasks that already carry hours.
  const _search = new URLSearchParams(window.location.search);
  const _devPhase = _search.get("dev") === "task-selection";
  const devSkipToReview =
    _devPhase && _search.get("review") === "1" && !_search.get("card");
  const devSkipToCard = _devPhase && _search.get("card") === "1";
  const devSkipToHours = _devPhase && _search.get("hours") === "1";

  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [showIntro, setShowIntro] = useState(
    !devSkipToReview && !devSkipToCard && !devSkipToHours,
  );
  const [showBonusToast, setShowBonusToast] = useState(false);
  const [lastBonusDelta, setLastBonusDelta] = useState(0);

  // Participant-typed tasks captured on the all-done screen.
  // Each entry carries the moment it was added so the per-task timestamp in
  // edits[] reflects when the participant actually typed it, not when they
  // hit Submit. (Submitting an 11-task batch used to stamp all 11 with the
  // same millisecond.)
  const [extraTasks, setExtraTasks] = useState<
    { name: string; addedAt: number; hoursPerWeek?: number }[]
  >([]);
  const [extraInput, setExtraInput] = useState("");

  // After the review/add screen, participants confirm how their indicated hours
  // are distributed across the week before the response is finalized. The
  // hours=1 dev shortcut opens directly on it.
  const [showHoursSummary, setShowHoursSummary] = useState(devSkipToHours);

  const bonusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Edit bonus: per-character (Levenshtein), capped at EDIT_BONUS_MAX_USD.
  const editChars = totalEditChars(tasks);
  const editEarnedUsd = Math.min(
    editChars * EDIT_BONUS_PER_CHAR_USD,
    EDIT_BONUS_MAX_USD,
  );
  const editCapped = editChars * EDIT_BONUS_PER_CHAR_USD >= EDIT_BONUS_MAX_USD;
  // Add bonus: flat per-task, capped at ADD_BONUS_MAX_USD.
  const addCount = extraTasks.length;
  const addEarnedUsd = Math.min(
    addCount * ADD_BONUS_PER_TASK_USD,
    ADD_BONUS_MAX_USD,
  );
  const addCapped = addCount * ADD_BONUS_PER_TASK_USD >= ADD_BONUS_MAX_USD;
  // AI-use bonus: per-character on aiHowSo across confirmed real (non-attention)
  // tasks, capped at AI_HOWSO_BONUS_MAX_USD. Rewards descriptive answers to
  // "how do you use AI for this?".
  const aiHowSoChars = tasks.reduce((sum, t) => {
    if (t.isAttentionCheck) return sum;
    return sum + (t.aiHowSo?.length ?? 0);
  }, 0);
  const aiHowSoEarnedUsd = Math.min(
    aiHowSoChars * AI_HOWSO_BONUS_PER_CHAR_USD,
    AI_HOWSO_BONUS_MAX_USD,
  );
  const aiHowSoCapped =
    aiHowSoChars * AI_HOWSO_BONUS_PER_CHAR_USD >= AI_HOWSO_BONUS_MAX_USD;

  // Kick off task load immediately (runs during intro screen).
  // We skip the domain-generation step and ask the model directly for a breadth-spanning
  // set of tasks for this role. Faster (one LLM call instead of N+1) and the model handles
  // breadth on its own when told to.
  const didLoadRef = useRef(false);
  useEffect(() => {
    if (devSkipToReview || devSkipToCard || devSkipToHours) return; // dev shortcut: tasks are already seeded
    if (didLoadRef.current) return; // one-shot: never re-generate (StrictMode double-invoke, re-render, re-mount)
    didLoadRef.current = true;
    async function load() {
      try {
        // First pass: pull the activities the participant explicitly mentioned
        // in the background interview. These get persisted (audit trail) and
        // passed to the generator as grounding context so the generator fills
        // gaps instead of echoing what the participant already said.
        // Failure is non-fatal: if extraction returns nothing / errors, the
        // generator just runs without grounding (its old behavior).
        let interviewTasks: string[] = [];
        try {
          interviewTasks = await extractInterviewTasks(backgroundTranscript, {
            jobTitle: userProfile.jobTitle,
            responsibilities: userProfile.responsibilities,
          });
          setInterviewExtractedTasks(interviewTasks);
        } catch (e) {
          console.warn(
            "[task-selection] extract failed, generating without grounding:",
            e,
          );
        }

        // Stream tasks into the picker as they arrive — the participant can
        // start rating the first task in ~1-2s instead of waiting ~7s for the
        // whole list. Attention checks are spliced in inline at the same
        // ATTENTION_CHECK_INTERVAL cadence; the hard 20-item cap still applies.
        // Linear indexing into the (already shuffled) FALLBACK_ATTENTION_CHECKS
        // guarantees no repeats within a session.
        let realCount = 0;
        const onTask = (name: string, id?: string) => {
          realCount += 1;
          setTasks((prev) => {
            if (prev.length >= MAX_TASKS) return prev;
            return [
              ...prev,
              { name, originalName: name, bankId: id, status: "unreviewed" },
            ];
          });
          if (realCount === 1) setLoadState("ready");
        };
        await generateTasksFromInterview(
          userProfile.jobTitle,
          userProfile.typicalWeek,
          userProfile.aiUsage,
          userProfile.responsibilities,
          interviewTasks,
          (name) => onTask(name),
        );
        // If the stream returned zero tasks (model fluke), surface an error
        // state so the participant sees something rather than a frozen loader.
        if (realCount === 0) setLoadState("error");
      } catch (e) {
        console.error("Task load failed", e);
        setLoadState("error");
      }
    }
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const saveEdit = (idx: number, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const before = totalEditChars(tasks);
    const now = Date.now();
    const next = tasks.map((t, i) => {
      if (i !== idx) return t;
      // No-op edit (e.g. user opened the editor and saved unchanged) — don't record anything.
      if (trimmed === t.name) return t;
      const stepDistance = levenshtein(t.name, trimmed);
      const editEntry = {
        from: t.name,
        to: trimmed,
        charsChanged: stepDistance,
        timestamp: now,
      };
      const changed = trimmed !== t.originalName;
      return {
        ...t,
        name: trimmed,
        status: changed ? "edited" : t.status,
        edits: [...(t.edits ?? []), editEntry],
      };
    });
    setTasks(next);
    const after = totalEditChars(next);
    if (after > before) {
      setLastBonusDelta(after - before);
      setShowBonusToast(true);
      if (bonusTimerRef.current) clearTimeout(bonusTimerRef.current);
      bonusTimerRef.current = setTimeout(() => setShowBonusToast(false), 2200);
    }
  };

  const advance = (answer: "yes" | "no", meta?: { hoursPerWeek: number }) => {
    const reviewedTask = tasks[currentIdx];

    // Active-learning write-back: record confirm/deny for bank-sourced tasks (the loop).
    // Best-effort/fire-and-forget. Skip attention checks and participant-added tasks (no bankId).
    if (reviewedTask?.bankId && !reviewedTask.isAttentionCheck) {
      const sid = useWorkflowStore.getState().sessionId;
      postTaskResponse({
        participant: prolific.pid || sid,
        task: reviewedTask.bankId,
        response: answer === "yes" ? "confirm" : "deny",
      });
    }

    setTasks((prev) =>
      prev.map((t, i) => {
        if (i !== currentIdx) return t;
        if (answer === "no") return { ...t, status: "removed" };
        return {
          ...t,
          status: t.status === "edited" ? "edited" : "confirmed",
          hoursPerWeek: meta?.hoursPerWeek,
        };
      }),
    );

    // Hard block: if this was an attention check answered "yes", count it as a fail.
    // Once fails exceed the configured threshold, route to the screen-out phase.
    if (reviewedTask?.isAttentionCheck && answer === "yes") {
      const nextFails = prolific.attnCheckFails + 1;
      setProlific({ attnCheckFails: nextFails });
      if (nextFails > prolific.attnCheckMaxFails) {
        setProlific({ screenedOut: true });
        if (prolific.pid) {
          const sid = useWorkflowStore.getState().sessionId;
          recordScreenOut(prolific.pid, sid, "attention-check-failed").catch(
            () => {},
          );
        }
        setTaskItems(
          tasks.map((t, i) =>
            i !== currentIdx ? t : { ...t, status: "confirmed" },
          ),
        );
        setPhase("screen-out");
        return;
      }
    }

    setCurrentIdx((i) => i + 1);
  };

  const addExtraTask = (raw: string) => {
    const t = raw.trim();
    if (!t) return;
    if (extraTasks.some((e) => e.name === t)) return; // dedup against what they've already added
    setExtraTasks((prev) => [...prev, { name: t, addedAt: Date.now() }]);
    setExtraInput("");
  };

  const removeExtraTask = (idx: number) => {
    setExtraTasks((prev) => prev.filter((_, i) => i !== idx));
  };

  // Step 1 of finishing: commit any un-added draft task, then move to the
  // hours-distribution confirmation screen. When the hours feature is off, skip
  // the summary and finalize directly (passing the pending task through so it's
  // still captured).
  const goToHoursSummary = (pendingExtra?: string) => {
    if (!HOURS_ENABLED) {
      finalize(pendingExtra);
      return;
    }
    const trimmedPending = pendingExtra?.trim() ?? "";
    if (trimmedPending && !extraTasks.some((e) => e.name === trimmedPending)) {
      setExtraTasks((prev) => [
        ...prev,
        { name: trimmedPending, addedAt: Date.now() },
      ]);
    }
    setShowHoursSummary(true);
  };

  // Edit a confirmed picker task's hours from the summary screen.
  const setTaskHours = (idx: number, hours: number | undefined) => {
    setTasks((prev) =>
      prev.map((t, i) => (i === idx ? { ...t, hoursPerWeek: hours } : t)),
    );
  };

  // Edit an added task's hours from the summary screen.
  const setExtraHours = (idx: number, hours: number | undefined) => {
    setExtraTasks((prev) =>
      prev.map((e, i) => (i === idx ? { ...e, hoursPerWeek: hours } : e)),
    );
  };

  // Step 2: finalize the response. Called from the hours summary's Continue, or
  // directly from goToHoursSummary when the hours feature is off (in which case
  // a pending un-added draft task may still need committing here).
  const finalize = (pendingExtra?: string) => {
    const trimmedPending = pendingExtra?.trim() ?? "";
    const finalExtras =
      trimmedPending && !extraTasks.some((e) => e.name === trimmedPending)
        ? [...extraTasks, { name: trimmedPending, addedAt: Date.now() }]
        : extraTasks;

    // Tasks the participant typed in get appended as confirmed, flagged as participant-added.
    const extraItems: TaskItem[] = finalExtras.map((e) => ({
      name: e.name,
      originalName: e.name,
      status: "confirmed",
      category: "__participant_added__",
      addedByParticipant: true,
      hoursPerWeek: e.hoursPerWeek,
      edits: [
        {
          from: "",
          to: e.name,
          charsChanged: e.name.length,
          timestamp: e.addedAt,
        },
      ],
    }));

    const allTasks = [...tasks, ...extraItems];
    const confirmed = allTasks
      .filter((t) => t.status === "confirmed" || t.status === "edited")
      .map((t) => t.name);

    // Freeze the bonus the participant earned at submit time. Char counts are
    // still recorded as activity metadata, but when the bonus feature is off
    // every earned amount is forced to $0.
    const finalEditChars = totalEditChars(allTasks);
    const finalEditEarned = BONUS_ENABLED
      ? Math.min(finalEditChars * EDIT_BONUS_PER_CHAR_USD, EDIT_BONUS_MAX_USD)
      : 0;
    const finalEditCapped =
      BONUS_ENABLED &&
      finalEditChars * EDIT_BONUS_PER_CHAR_USD >= EDIT_BONUS_MAX_USD;
    const finalAddCount = finalExtras.length;
    const finalAddEarned = BONUS_ENABLED
      ? Math.min(finalAddCount * ADD_BONUS_PER_TASK_USD, ADD_BONUS_MAX_USD)
      : 0;
    const finalAddCapped =
      BONUS_ENABLED &&
      finalAddCount * ADD_BONUS_PER_TASK_USD >= ADD_BONUS_MAX_USD;
    const finalAiHowSoChars = allTasks.reduce((sum, t) => {
      if (t.isAttentionCheck) return sum;
      return sum + (t.aiHowSo?.length ?? 0);
    }, 0);
    const finalAiHowSoEarned = BONUS_ENABLED
      ? Math.min(
          finalAiHowSoChars * AI_HOWSO_BONUS_PER_CHAR_USD,
          AI_HOWSO_BONUS_MAX_USD,
        )
      : 0;
    const finalAiHowSoCapped =
      BONUS_ENABLED &&
      finalAiHowSoChars * AI_HOWSO_BONUS_PER_CHAR_USD >= AI_HOWSO_BONUS_MAX_USD;

    setSelectedTasks(confirmed);
    setTaskItems(allTasks);
    setBonusSnapshot({
      editChars: finalEditChars,
      editEarnedUsd: finalEditEarned,
      editCapped: finalEditCapped,
      addCount: finalAddCount,
      addEarnedUsd: finalAddEarned,
      addCapped: finalAddCapped,
      aiHowSoChars: finalAiHowSoChars,
      aiHowSoEarnedUsd: finalAiHowSoEarned,
      aiHowSoCapped: finalAiHowSoCapped,
      totalEarnedUsd: finalEditEarned + finalAddEarned + finalAiHowSoEarned,
      rates: {
        editPerCharUsd: EDIT_BONUS_PER_CHAR_USD,
        editMaxUsd: EDIT_BONUS_MAX_USD,
        addPerTaskUsd: ADD_BONUS_PER_TASK_USD,
        addMaxUsd: ADD_BONUS_MAX_USD,
        aiHowSoPerCharUsd: AI_HOWSO_BONUS_PER_CHAR_USD,
        aiHowSoMaxUsd: AI_HOWSO_BONUS_MAX_USD,
      },
      computedAt: new Date().toISOString(),
    });
    setPhase(condition === "short" ? "final-questions" : "task-priority");
  };

  const confirmedCount = tasks.filter(
    (t) => t.status === "confirmed" || t.status === "edited",
  ).length;
  const canEarlyExit = currentIdx >= DONE_THRESHOLD && confirmedCount >= 1;
  const isExhausted = currentIdx >= tasks.length && loadState === "ready";
  const currentTask = tasks[currentIdx];
  const loading =
    loadState === "loading" ||
    (loadState === "ready" && !currentTask && !isExhausted);

  if (showIntro) {
    return (
      <IntroScreen
        onStart={() => setShowIntro(false)}
        totalParts={totalParts}
      />
    );
  }

  if (showHoursSummary) {
    // Indices into `tasks` are preserved so inline edits map back to the right
    // confirmed picker task; added tasks are edited against extraTasks order.
    const confirmedPickerTasks = tasks
      .map((t, idx) => ({ t, idx }))
      .filter(
        ({ t }) =>
          (t.status === "confirmed" || t.status === "edited") &&
          !t.isAttentionCheck,
      );
    return (
      <HoursSummaryScreen
        totalParts={totalParts}
        confirmedPickerTasks={confirmedPickerTasks}
        extraTasks={extraTasks}
        onSetTaskHours={setTaskHours}
        onSetExtraHours={setExtraHours}
        onConfirm={finalize}
      />
    );
  }

  return (
    <div className="flex flex-col h-full bg-transparent relative overflow-hidden">
      {/* Top gradient is rendered by the parent (App.tsx) so it spans the full viewport. */}

      {/* Bonus toast — shows the per-edit character delta */}
      {BONUS_ENABLED && (
        <div
          className={`absolute top-4 right-4 z-50 transition-all duration-300 ${showBonusToast ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-2 pointer-events-none"}`}
        >
          <div className="flex items-center gap-1.5 px-3 py-2 bg-amber-400 text-amber-900 text-xs font-semibold rounded-full shadow-md">
            ★ +{lastBonusDelta} char{lastBonusDelta !== 1 ? "s" : ""} edited
          </div>
        </div>
      )}

      {/* Header */}
      <div className="relative z-10 px-8 pt-8 pb-5 shrink-0">
        <div className="flex items-center justify-between mb-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-indigo-400">
            Part 2 of {totalParts} — Task Coverage
          </p>
          {BONUS_ENABLED &&
            !isExhausted &&
            (editChars > 0 || aiHowSoChars > 0) && (
              <span className="text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
                ★ {formatUsd(editEarnedUsd + aiHowSoEarnedUsd)}
                {editCapped && aiHowSoCapped ? " (max)" : ""}
              </span>
            )}
        </div>
        <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
          {/* Linear progress over the full picker (MAX_TASKS). isExhausted
              still pegs to 100% so a short stream (fewer tasks than the cap)
              shows a full bar when the participant finishes the last one. */}
          <div
            className="h-full rounded-full bg-gradient-to-r from-indigo-400 to-violet-400 transition-all duration-500 ease-out"
            style={{
              width: `${isExhausted ? 100 : Math.min((currentIdx / MAX_TASKS) * 100, 100)}%`,
            }}
          />
        </div>
      </div>

      {/* Task area */}
      <div
        className={`relative z-10 flex-1 flex flex-col min-h-0 overflow-y-auto
        ${isExhausted ? "justify-start pt-6 pb-12 px-4 sm:px-6" : "px-8"}`}
      >
        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="flex gap-2">
              {[0, 150, 300].map((d) => (
                <span
                  key={d}
                  className="w-2 h-2 bg-indigo-200 rounded-full animate-bounce"
                  style={{ animationDelay: `${d}ms` }}
                />
              ))}
            </div>
          </div>
        ) : loadState === "error" ? (
          <div className="text-center space-y-3">
            <p className="text-slate-500 text-sm">
              Couldn't load tasks — is the server running?
            </p>
            <button
              onClick={() => {
                setLoadState("loading");
              }}
              className="text-indigo-500 text-sm underline"
            >
              Retry
            </button>
          </div>
        ) : isExhausted ? (
          <ReviewAndAddScreen
            confirmedTasks={tasks.filter(
              (t) =>
                (t.status === "confirmed" || t.status === "edited") &&
                !t.isAttentionCheck,
            )}
            interviewExtractedTasks={interviewExtractedTasks}
            extraTasks={extraTasks}
            extraInput={extraInput}
            onExtraInputChange={setExtraInput}
            onAddExtra={addExtraTask}
            onRemoveExtra={removeExtraTask}
            addEarnedUsd={addEarnedUsd}
            addCapped={addCapped}
            onSubmit={goToHoursSummary}
          />
        ) : currentTask ? (
          <div className="w-full max-w-[600px] mx-auto h-full">
            <TaskReviewCard
              key={currentIdx}
              task={currentTask}
              taskIdx={currentIdx}
              isLast={currentIdx >= tasks.length - 1}
              hasEditedAnyTask={tasks.some((t) => (t.edits?.length ?? 0) > 0)}
              onSaveEdit={saveEdit}
              onAdvance={advance}
            />
          </div>
        ) : null}
      </div>

      {/* Footer — early-exit hint, only shown mid-flow (the exhausted screen has its own primary button) */}
      {canEarlyExit && !isExhausted && (
        <div className="relative z-10 px-8 pb-8 pt-4 border-t border-slate-100 shrink-0">
          <button
            onClick={() => goToHoursSummary()}
            className="w-full text-sm text-slate-400 hover:text-slate-600 transition py-1"
          >
            Done — continue with {confirmedCount} task
            {confirmedCount !== 1 ? "s" : ""}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Intro screen ───────────────────────────────────────────────────────────────

function IntroScreen({
  onStart,
  totalParts,
}: {
  onStart: () => void;
  totalParts: number;
}) {
  return (
    <div className="flex flex-col h-full bg-transparent relative overflow-hidden">
      {/* Top gradient is rendered by the parent (App.tsx) so it spans the full viewport. */}
      <div className="relative z-10 flex flex-1 items-center justify-center px-8">
        <div className="max-w-lg w-full">
          <p
            className="text-[10px] font-semibold uppercase tracking-[0.18em] text-indigo-400 mb-9 animate-fadeSlideUp"
            style={{ animationDelay: "0ms" }}
          >
            Part 2 of {totalParts} — Task Coverage
          </p>
          <h2
            className="text-[1.65rem] font-light text-slate-800 leading-snug tracking-tight animate-fadeSlideUp"
            style={{ animationDelay: "80ms" }}
          >
            We built a task list from your interview.
          </h2>
          <p
            className="text-slate-500 mt-6 text-[15px] leading-[1.7] animate-fadeSlideUp"
            style={{ animationDelay: "160ms" }}
          >
            Based on what you just described, we've put together a list of tasks for your role. Some come directly from what you told us — others fill in gaps we think might be missing.
          </p>
          <p
            className="text-slate-500 mt-4 text-[15px] leading-[1.7] animate-fadeSlideUp"
            style={{ animationDelay: "220ms" }}
          >
            Confirm which tasks you actually do, and reword any that don't quite match how you'd describe them.
          </p>
          <div className="mt-12 space-y-4">
            {BONUS_ENABLED && (
              <div
                className="px-5 py-4 rounded-xl border border-amber-200 bg-amber-50 animate-fadeSlideUp"
                style={{ animationDelay: "320ms" }}
              >
                <div className="text-sm leading-[1.6]">
                  <p className="font-semibold text-amber-700 mb-1.5">
                    Edit bonus
                  </p>
                  <p className="text-slate-700">
                    Edit any task to make it more personalized to your work.
                    We'll give you a bonus for each character you change.
                  </p>
                  <p className="mt-2.5 text-amber-800">
                    <span className="font-semibold">
                      {formatUsd(EDIT_BONUS_PER_CHAR_USD * 1000)} per 1,000
                      characters
                    </span>{" "}
                    changed, up to {formatUsd(EDIT_BONUS_MAX_USD)}.
                  </p>
                </div>
              </div>
            )}
          </div>
          <button
            onClick={onStart}
            className="mt-14 inline-flex items-center gap-2 px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-full transition-all active:scale-[0.98] shadow-sm shadow-indigo-200 animate-fadeSlideUp"
            style={{ animationDelay: "420ms" }}
          >
            Start
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
    </div>
  );
}

// ── Hours distribution summary ──────────────────────────────────────────────────

// Reference point for the plausibility hint — a conventional full-time week.
const FULL_WEEK_HOURS = 40;

function formatHours(n: number): string {
  // Drop the trailing ".0" but keep halves etc. (e.g. 3, 3.5, 10).
  return Number.isInteger(n) ? `${n}` : `${n.toFixed(1)}`;
}

// Curated categorical palette — distinct enough to match a bar segment to its
// row, but harmonious rather than a full-spectrum rainbow. Cycles if there are
// more tasks than colors. The same color drives the segment, the row's dot, and
// the slider fill.
const TASK_PALETTE = [
  "#6366f1", // indigo
  "#0ea5e9", // sky
  "#14b8a6", // teal
  "#f59e0b", // amber
  "#f43f5e", // rose
  "#8b5cf6", // violet
  "#10b981", // emerald
  "#fb7185", // pink
  "#3b82f6", // blue
  "#a855f7", // purple
  "#f97316", // orange
  "#06b6d4", // cyan
];
function segmentColor(i: number): string {
  return TASK_PALETTE[i % TASK_PALETTE.length];
}

// Upper bound for the per-task slider. The −/+ stepper can still push past this
// (the slider just pegs at max) so it never caps what a participant can enter.
const SLIDER_MAX = 40;

// One editable task row: task name on top, then a colored slider for a quick
// estimate plus a −/value/+ stepper to fine-tune to the half hour. The slider's
// filled track is the task's color (set via --fill/--pct in index.css).
function HoursSliderRow({
  name,
  hours,
  color,
  badge,
  onChange,
}: {
  name: string;
  hours: number | undefined;
  color: string;
  badge?: string;
  onChange: (hours: number | undefined) => void;
}) {
  const current = hours ?? 0;
  const sliderValue = Math.min(Math.max(current, 0), SLIDER_MAX);
  // Commit a clean half-hour value, never below zero.
  const commit = (v: number) => onChange(Math.max(0, Math.round(v * 2) / 2));

  const stepBtn =
    "w-8 h-8 shrink-0 rounded-lg border border-slate-200 text-slate-400 hover:border-indigo-300 hover:text-indigo-500 hover:bg-indigo-50 active:scale-95 transition flex items-center justify-center text-base leading-none";

  return (
    <div className="py-2">
      <p className="flex items-center gap-2 text-sm font-medium text-slate-700">
        <span
          className="w-2 h-2 rounded-full shrink-0 ring-2 ring-white shadow-sm"
          style={{ background: color }}
        />
        <span>{name}</span>
        {badge && (
          <span className="text-[10px] font-semibold uppercase tracking-wider text-indigo-400">
            {badge}
          </span>
        )}
      </p>
      <div className="mt-1.5 flex items-center gap-4">
        <input
          type="range"
          min={0}
          max={SLIDER_MAX}
          step={0.5}
          value={sliderValue}
          onChange={(e) => commit(parseFloat(e.target.value))}
          style={
            {
              color,
              "--fill": color,
              "--pct": `${(sliderValue / SLIDER_MAX) * 100}%`,
            } as React.CSSProperties
          }
          className="hours-slider flex-1 min-w-0 cursor-pointer"
        />
        <div className="shrink-0 flex items-center gap-2">
          <button
            type="button"
            aria-label={`Decrease hours for ${name}`}
            onClick={() => commit(current - 0.5)}
            className={stepBtn}
          >
            −
          </button>
          <div className="w-11 text-center">
            <span className="text-base font-medium text-slate-800 tabular-nums">
              {hours === undefined ? "—" : formatHours(hours)}
            </span>
            <span className="ml-0.5 text-xs text-slate-400">h</span>
          </div>
          <button
            type="button"
            aria-label={`Increase hours for ${name}`}
            onClick={() => commit(current + 0.5)}
            className={stepBtn}
          >
            +
          </button>
        </div>
      </div>
    </div>
  );
}

function HoursSummaryScreen({
  totalParts,
  confirmedPickerTasks,
  extraTasks,
  onSetTaskHours,
  onSetExtraHours,
  onConfirm,
}: {
  totalParts: number;
  confirmedPickerTasks: { t: TaskItem; idx: number }[];
  extraTasks: { name: string; addedAt: number; hoursPerWeek?: number }[];
  onSetTaskHours: (idx: number, hours: number | undefined) => void;
  onSetExtraHours: (idx: number, hours: number | undefined) => void;
  onConfirm: () => void;
}) {
  // One unified list so the bar segment, total, and legend all share an order
  // and color index.
  const items = [
    ...confirmedPickerTasks.map(({ t, idx }) => ({
      key: `picker-${idx}`,
      name: t.name,
      hours: t.hoursPerWeek,
      badge: undefined as string | undefined,
      onChange: (h: number | undefined) => onSetTaskHours(idx, h),
    })),
    ...extraTasks.map((e, i) => ({
      key: `extra-${i}`,
      name: e.name,
      hours: e.hoursPerWeek,
      badge: "added" as string | undefined,
      onChange: (h: number | undefined) => onSetExtraHours(i, h),
    })),
  ];
  const n = items.length;
  const total = items.reduce((s, it) => s + (it.hours ?? 0), 0);
  const taskCount = n;

  // Every listed task needs a valid figure before we let them confirm — picker
  // tasks already collected hours during review; added tasks may still be blank.
  const allFilled = items.every((it) => typeof it.hours === "number");

  // Soft plausibility hint — never blocks, just orients them.
  const hint =
    total === 0
      ? null
      : total > FULL_WEEK_HOURS * 2
        ? `That's more than ${FULL_WEEK_HOURS * 2} hours — more than most people work in a week. Adjust any that look off.`
        : total > FULL_WEEK_HOURS * 1.25
          ? `That's well above a typical ${FULL_WEEK_HOURS}-hour week. That's fine if it's accurate — just double-check.`
          : null;

  return (
    <div className="flex flex-col h-full bg-transparent relative overflow-hidden">
      {/* Header */}
      <div className="relative z-10 px-8 pt-8 pb-5 shrink-0">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-indigo-400 mb-4">
          Part 2 of {totalParts} — Task Coverage
        </p>
      </div>

      <div className="relative z-10 flex-1 flex flex-col min-h-0 overflow-y-auto justify-start pb-12 px-4 sm:px-8">
        <div className="w-full max-w-4xl mx-auto animate-fadeSlideIn">
          <h2 className="text-[1.5rem] font-light text-slate-800 leading-snug tracking-tight">
            Your week at a glance
          </h2>
          <p className="text-sm text-slate-500 mt-2 leading-relaxed">
            Here's how your hours add up across tasks. Drag a bar for a quick
            estimate, then use −/+ to fine-tune to the half hour.
          </p>

          {/* Total pill + stacked breakdown bar */}
          <div className="mt-6 px-6 py-5 rounded-2xl bg-indigo-50/70">
            <div>
              <span className="text-3xl font-semibold text-indigo-600 tabular-nums align-middle">
                {formatHours(total)}
              </span>
              <span className="ml-2 text-sm text-slate-500 align-middle">
                hours / week across {taskCount} task{taskCount !== 1 ? "s" : ""}
              </span>
            </div>

            <div className="mt-4 flex w-full h-12 rounded-xl overflow-hidden bg-indigo-100/60 ring-1 ring-inset ring-indigo-200/50">
              {total > 0 ? (
                items.map((it, i) => {
                  const pct = ((it.hours ?? 0) / total) * 100;
                  if (pct <= 0) return null;
                  return (
                    <div
                      key={it.key}
                      className="flex items-center justify-center text-white text-sm font-semibold border-r-[3px] border-white last:border-r-0 overflow-hidden whitespace-nowrap transition-[width] duration-300 ease-out"
                      style={{
                        width: `${pct}%`,
                        background: segmentColor(i),
                        textShadow: "0 1px 2px rgba(15,23,42,0.18)",
                      }}
                      title={`${it.name}: ${formatHours(it.hours ?? 0)}h`}
                    >
                      {pct >= 6 ? formatHours(it.hours ?? 0) : ""}
                    </div>
                  );
                })
              ) : (
                <div className="flex items-center justify-center w-full text-xs text-slate-400">
                  Set hours below to see your week
                </div>
              )}
            </div>
          </div>

          {/* Per-task rows — colored slider + −/value/+ stepper */}
          <div className="mt-4 divide-y divide-slate-100">
            {items.map((it, i) => (
              <HoursSliderRow
                key={it.key}
                name={it.name}
                hours={it.hours}
                color={segmentColor(i)}
                badge={it.badge}
                onChange={it.onChange}
              />
            ))}
          </div>

          {hint && (
            <p className="mt-4 flex items-start gap-2 text-sm leading-relaxed text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
              <svg
                className="w-4 h-4 mt-0.5 shrink-0 text-amber-500"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <span>{hint}</span>
            </p>
          )}

          <div className="mt-8 flex items-center justify-end gap-3">
            {!allFilled && (
              <p className="text-xs text-slate-400">
                Enter hours for every task to continue.
              </p>
            )}
            <button
              onClick={onConfirm}
              disabled={!allFilled}
              className="shrink-0 inline-flex items-center gap-2 px-7 py-3 bg-gradient-to-br from-indigo-500 to-indigo-600 hover:from-indigo-600 hover:to-indigo-700 disabled:opacity-30 disabled:cursor-not-allowed text-white text-sm font-medium rounded-full transition-all active:scale-[0.98] shadow-md shadow-indigo-200/70"
            >
              Continue
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Single task review card ────────────────────────────────────────────────────

interface TaskReviewCardProps {
  task: TaskItem;
  taskIdx: number;
  isLast: boolean;
  hasEditedAnyTask: boolean;
  onSaveEdit: (idx: number, name: string) => void;
  onAdvance: (answer: "yes" | "no", meta?: { hoursPerWeek: number }) => void;
}

function TaskReviewCard({
  task,
  taskIdx,
  isLast,
  hasEditedAnyTask,
  onSaveEdit,
  onAdvance,
}: TaskReviewCardProps) {
  const [primaryAnswer, setPrimaryAnswer] = useState<"yes" | "no" | null>(null);
  // Self-reported hours/week — only collected when "I do this" and the hours
  // feature is on. Stored as raw input text so the field can be empty
  // mid-typing; parsed on continue.
  const [hoursInput, setHoursInput] = useState("");
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(task.name);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const hoursValue = parseFloat(hoursInput);
  const hoursValid = Number.isFinite(hoursValue) && hoursValue >= 0;
  // "No" continues immediately; "Yes" requires a valid hours figure only while
  // the hours feature is on.
  const canContinue =
    primaryAnswer === "no" ||
    (primaryAnswer === "yes" && (!HOURS_ENABLED || hoursValid));

  const handleContinue = () => {
    if (!canContinue) return;
    if (primaryAnswer === "no") {
      onAdvance("no");
    } else {
      onAdvance(
        "yes",
        HOURS_ENABLED ? { hoursPerWeek: hoursValue } : undefined,
      );
    }
  };

  const startEdit = () => {
    setEditValue(task.name);
    setEditing(true);
    setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.style.height = "auto";
        inputRef.current.style.height = inputRef.current.scrollHeight + "px";
        inputRef.current.focus();
        inputRef.current.select();
      }
    }, 20);
  };

  const commitEdit = () => {
    setEditing(false);
    const trimmed = editValue.trim() || task.name;
    onSaveEdit(taskIdx, trimmed);
  };

  return (
    <div className="h-full relative">
      {/* Centered: task name + buttons. pb reserves space for the bottom section
          so the centering point never shifts when nudge/continue appear. */}
      <div className="h-full flex flex-col justify-center gap-7 pb-48">
        {/* Task name */}
        <div
          onClick={() => !editing && startEdit()}
          className="cursor-text select-none pb-1"
        >
          {editing ? (
            <textarea
              ref={inputRef}
              className="w-full text-2xl font-light text-slate-800 bg-transparent border-b-2 border-indigo-300 focus:outline-none pb-1 resize-none overflow-hidden leading-snug"
              value={editValue}
              rows={1}
              onChange={(e) => {
                setEditValue(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = e.target.scrollHeight + "px";
              }}
              onBlur={commitEdit}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitEdit();
                }
                if (e.key === "Escape") {
                  setEditing(false);
                  setEditValue(task.name);
                }
              }}
            />
          ) : (
            <div className="flex items-start gap-3">
              <p className="text-2xl font-light text-slate-800 leading-snug flex-1">
                {task.name}
              </p>
              <span className="mt-1 shrink-0 flex items-center justify-center w-8 h-8 rounded-full bg-slate-100 hover:bg-indigo-50 hover:text-indigo-600 text-slate-500 transition-colors">
                <svg
                  className="w-4 h-4"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M11 2l3 3-8 8H3v-3l8-8z" />
                </svg>
              </span>
            </div>
          )}
        </div>

        {/* Buttons */}
        <div className="flex gap-3">
          {(
            [
              {
                value: "yes",
                label: "I do this",
                active:
                  "bg-indigo-600 border-indigo-600 text-white shadow-sm shadow-indigo-200",
                inactive: "hover:border-indigo-200 hover:text-indigo-600",
              },
              {
                value: "no",
                label: "I don't do this",
                active: "bg-slate-100 border-slate-300 text-slate-700",
                inactive: "hover:border-slate-300",
              },
            ] as {
              value: "yes" | "no";
              label: string;
              active: string;
              inactive: string;
            }[]
          ).map(({ value, label, active, inactive }) => (
            <button
              key={value}
              onClick={() => {
                setPrimaryAnswer(value);
                if (value === "no") setHoursInput("");
              }}
              className={`flex-1 py-3 rounded-2xl border text-sm font-medium transition-all active:scale-[0.98] ${
                primaryAnswer === value
                  ? active
                  : `bg-white border-slate-200 text-slate-600 ${inactive}`
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {/* end centered section */}

      {/* Bottom: absolutely pinned so it never affects the centered layout */}
      <div className="absolute bottom-0 left-0 right-0 space-y-4 pb-12">
        {/* Nudge */}
        {primaryAnswer === "yes" &&
          !hasEditedAnyTask &&
          taskIdx >= NUDGE_AFTER_UNEDITED && (
            <div
              onClick={() => !editing && startEdit()}
              className={`flex items-start gap-3 px-4 py-3.5 rounded-xl bg-amber-50 border border-amber-200 ${editing ? "cursor-default" : "cursor-text"} animate-fadeSlideIn`}
            >
              <svg
                className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-500"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M11 2l3 3-8 8H3v-3l8-8z" />
              </svg>
              <p className="text-sm text-amber-700 leading-relaxed">
                {editing ? (
                  "Great — reword it so it reflects how you actually do this."
                ) : (
                  <>
                    <span className="font-semibold text-amber-800">
                      Make it yours.
                    </span>{" "}
                    Click the title above and reword it in your own terms.
                  </>
                )}
              </p>
            </div>
          )}

        {/* Hours follow-up — only when the participant does this task and the
          hours feature is on */}
        {HOURS_ENABLED && primaryAnswer === "yes" && (
          <div className="space-y-5 pt-5 animate-fadeSlideIn">
            <p className="text-base font-normal text-slate-500">
              In a typical week, how many hours do you spend on this?
            </p>
            <div className="flex items-center gap-3">
              <input
                type="number"
                min={0}
                step={0.5}
                inputMode="decimal"
                value={hoursInput}
                onChange={(e) => setHoursInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canContinue) handleContinue();
                }}
                placeholder="e.g. 3"
                className="w-28 px-3.5 py-2.5 text-sm text-slate-700 placeholder:text-slate-300 bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300 transition"
              />
              <span className="text-sm text-slate-500">hours / week</span>
            </div>
          </div>
        )}

        {/* Continue */}
        {primaryAnswer !== null && (
          <button
            onClick={handleContinue}
            disabled={!canContinue}
            className="self-end px-5 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-30 text-white text-sm font-medium rounded-xl transition-all active:scale-[0.98]"
          >
            {isLast ? "Done →" : "Continue →"}
          </button>
        )}
      </div>
      {/* end bottom section */}
    </div>
  );
}

type RecordState = "idle" | "recording" | "transcribing";

// ── Review & add screen ────────────────────────────────────────────────────────

function ReviewAndAddScreen({
  confirmedTasks,
  interviewExtractedTasks,
  extraTasks,
  extraInput,
  onExtraInputChange,
  onAddExtra,
  onRemoveExtra,
  addEarnedUsd,
  addCapped,
  onSubmit,
}: {
  confirmedTasks: TaskItem[];
  interviewExtractedTasks: string[];
  extraTasks: { name: string; addedAt: number }[];
  extraInput: string;
  onExtraInputChange: (v: string) => void;
  onAddExtra: (v: string) => void;
  onRemoveExtra: (idx: number) => void;
  addEarnedUsd: number;
  addCapped: boolean;
  onSubmit: (pendingExtra?: string) => void;
}) {
  // Merge in the activities extracted from the background interview, deduped
  // (case-insensitive + trim) against the explicitly confirmed tasks. Anything
  // the participant described but that didn't surface via the review flow still
  // shows up here so the "tasks so far" picture is complete.
  const seenNames = new Set(
    confirmedTasks.map((t) => t.name.trim().toLowerCase()),
  );
  const extractedOnly = interviewExtractedTasks.filter((name) => {
    const key = name.trim().toLowerCase();
    if (!key || seenNames.has(key)) return false;
    seenNames.add(key);
    return true;
  });
  const totalDisplayedSoFar = confirmedTasks.length + extractedOnly.length;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [recordState, setRecordState] = useState<RecordState>("idle");
  const [recordError, setRecordError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  const handleAddExtra = (v: string) => {
    onAddExtra(v);
  };

  // Mode-switching primary button: while there's draft text in the input, the
  // button commits it as a task and clears the input — it does NOT submit.
  // Only when the input is empty does the button finalize the response. This
  // prevents accidentally submitting in the middle of typing a task.
  const draft = extraInput.trim();
  const hasDraft = draft.length > 0;
  const handlePrimary = () => {
    if (hasDraft) {
      onAddExtra(draft);
      return;
    }
    onSubmit();
  };

  const toggleRecording = async () => {
    if (recordState === "recording") {
      mediaRecorderRef.current?.stop();
      return;
    }
    if (recordState === "transcribing") return;
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
        if (!chunks.length) {
          setRecordState("idle");
          return;
        }
        setRecordState("transcribing");
        try {
          const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
          const text = await transcribeAudio(blob);
          if (text.trim()) {
            onExtraInputChange(extraInput ? extraInput + " " + text : text);
            setTimeout(() => textareaRef.current?.focus(), 50);
          }
        } catch {
          setRecordError("Transcription failed — try typing instead.");
        } finally {
          setRecordState("idle");
        }
      };
      recorder.start(250);
      setRecordError(null);
      setRecordState("recording");
    } catch {
      setRecordError("Mic access denied — please type your answer.");
    }
  };

  return (
    <div className="w-full animate-fadeSlideIn">
      {totalDisplayedSoFar > 0 && (
        <section>
          <h3 className="text-[1.35rem] font-light text-slate-800 leading-snug tracking-tight">
            Here are your tasks so far
          </h3>
          <p className="text-sm text-slate-500 mt-1.5">
            {totalDisplayedSoFar} task{totalDisplayedSoFar !== 1 ? "s" : ""}{" "}
            from what you confirmed and what you mentioned earlier.
          </p>

          <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {confirmedTasks.map((t, i) => (
              <div
                key={`${t.name}-${i}`}
                className="px-4 py-3 rounded-xl bg-white border border-slate-200 hover:border-indigo-200 hover:shadow-sm transition"
              >
                <p className="text-sm text-slate-800 leading-snug">{t.name}</p>
                {t.status === "edited" && (
                  <span className="mt-1.5 inline-block text-[10px] font-semibold uppercase tracking-wider text-amber-600">
                    edited
                  </span>
                )}
              </div>
            ))}
            {extractedOnly.map((name, i) => (
              <div
                key={`extracted-${name}-${i}`}
                className="px-4 py-3 rounded-xl bg-white border border-slate-200 hover:border-indigo-200 hover:shadow-sm transition"
              >
                <p className="text-sm text-slate-800 leading-snug">{name}</p>
                <span className="mt-1.5 inline-block text-[10px] font-semibold uppercase tracking-wider text-indigo-500">
                  from interview
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* What else fills your week. */}
      <section className="mt-10">
        <div className="flex items-center justify-between gap-4">
          <h3 className="text-[1.35rem] font-light text-slate-800 leading-snug tracking-tight">
            What else fills your week?
          </h3>
          {BONUS_ENABLED && (
            <span className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-50 border border-amber-200 text-xs font-medium text-amber-700 whitespace-nowrap">
              {formatUsd(addEarnedUsd)}
              {addCapped ? " (max)" : ""}
            </span>
          )}
        </div>
        <p className="text-sm text-slate-500 mt-3 leading-relaxed">
          We almost certainly missed something. Add the tasks that didn't make
          our list.
        </p>
        {BONUS_ENABLED && (
          <p className="text-xs text-amber-700 mt-3">
            Earn {formatUsd(ADD_BONUS_PER_TASK_USD)} for each task you add, up
            to {formatUsd(ADD_BONUS_MAX_USD)}.
          </p>
        )}

        <div className="mt-4 relative">
          <textarea
            ref={textareaRef}
            rows={3}
            value={extraInput}
            onChange={(e) => onExtraInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleAddExtra(extraInput);
              }
            }}
            placeholder={
              recordState === "recording"
                ? "Recording — click the mic again to stop"
                : recordState === "transcribing"
                  ? "Transcribing…"
                  : "Type a task and press Enter — or use the mic to dictate"
            }
            disabled={recordState === "transcribing"}
            className="w-full pl-4 pr-14 py-3 text-sm text-slate-700 placeholder:text-slate-400 bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300 transition resize-none disabled:opacity-60"
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
        {/* <p className="mt-1.5 text-[11px] text-slate-400">
          <kbd className="bg-slate-100 px-1.5 py-0.5 rounded text-[10px] font-mono text-slate-500 mr-1">
            Enter
          </kbd>
          to add ·{" "}
          <kbd className="bg-slate-100 px-1.5 py-0.5 rounded text-[10px] font-mono text-slate-500 mr-1">
            Shift+Enter
          </kbd>
          for newline
        </p> */}
        {recordError && (
          <p className="mt-1.5 text-xs text-red-500">{recordError}</p>
        )}

        {extraTasks.length > 0 && (
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {extraTasks.map((t, i) => (
              <div
                key={`${t.name}-${i}`}
                className="group relative pl-4 pr-10 py-3 rounded-xl bg-white border border-indigo-200 hover:shadow-sm transition"
              >
                <p className="text-sm text-slate-800 leading-snug">{t.name}</p>
                <button
                  type="button"
                  onClick={() => onRemoveExtra(i)}
                  aria-label={`Remove ${t.name}`}
                  title="Remove task"
                  className="absolute top-1/2 -translate-y-1/2 right-2 w-6 h-6 flex items-center justify-center rounded-full text-slate-300 hover:text-red-500 hover:bg-red-50 transition"
                >
                  <svg
                    viewBox="0 0 20 20"
                    className="w-3.5 h-3.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  >
                    <line x1="6" y1="6" x2="14" y2="14" />
                    <line x1="14" y1="6" x2="6" y2="14" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="mt-8 flex items-center justify-end gap-3">
        {/* {hasDraft && (
          // <p className="text-[11px] text-slate-400">
          //   Click to add the task you're typing — submit when the input is
          //   empty.
          // </p>
        )} */}
        <button
          onClick={handlePrimary}
          aria-label={hasDraft ? "Add task" : "Submit"}
          className={`shrink-0 inline-flex items-center gap-2 px-7 py-3 text-white text-sm font-medium rounded-full transition-all active:scale-[0.98] shadow-md cursor-pointer
            ${
              hasDraft
                ? "bg-gradient-to-br from-indigo-400 to-indigo-500 hover:from-indigo-500 hover:to-indigo-600 shadow-indigo-100"
                : "bg-gradient-to-br from-indigo-500 to-indigo-600 hover:from-indigo-600 hover:to-indigo-700 shadow-indigo-200/70"
            }`}
        >
          {hasDraft ? (
            <>
              Add task
              <svg
                className="w-4 h-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </>
          ) : (
            <>
              Submit
              <svg
                className="w-4 h-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="5" y1="12" x2="19" y2="12" />
                <polyline points="12 5 19 12 12 19" />
              </svg>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
