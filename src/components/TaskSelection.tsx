import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  generateTasksForCategoryStream,
  recordScreenOut,
  transcribeAudio,
} from "../lib/api";
import { useWorkflowStore } from "../store";
import { BONUS_ENABLED } from "../lib/bonus";
import { TaskItem } from "../types";

// Hard cap on the picker list (real tasks + spliced attention checks). Also
// the progress-bar denominator so the bar reflects actual rating progress.
const MAX_TASKS = 15;

// Number of tasks the participant must rate before the "Finish early"
// affordance unlocks. Pinned to MAX_TASKS so the threshold tracks the picker
// cap — finishing early now means "after the full list".
const DONE_THRESHOLD = MAX_TASKS;

// One attention check inserted after every N real tasks (positions N, 2N, 3N, …).
const ATTENTION_CHECK_INTERVAL = 4;

// O*NET-style fallback attention checks. Drawn from clearly unrelated
// occupations so participants can always answer "I don't do this" honestly.
// Shuffled once per page load so each session sees the checks in a different
// order — within a session the picker indexes linearly so no check repeats,
// and across sessions the rotation differs without any state to persist.
const FALLBACK_ATTENTION_CHECKS: string[] = [
  "Triage walk-in emergency-room patients to determine treatment priority based on presenting symptoms.",
  "Replace residential service-panel circuit breakers during scheduled electrical maintenance calls.",
  "Pull and dispense espresso shots to fulfill customer drink orders during peak café shifts.",
  "Inspect commercial brake systems on customer vehicles to identify worn pads and rotors.",
  "Harvest field crops by operating a combine across designated rows during the harvest window.",
  "Conduct routine traffic stops on patrol to enforce posted speed and equipment regulations.",
  "Cut and style hair for walk-in salon clients based on consultation and customer preference.",
  "Operate forklift equipment on a warehouse floor to move palletized inventory between zones.",
].sort(() => Math.random() - 0.5);

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
    interviewExtractedTasks,
    setSelectedTasks,
    setTaskItems,
    setBonusSnapshot,
    setPhase,
    prolific,
    setProlific,
    condition,
  } = useWorkflowStore(
    useShallow((s) => ({
      userProfile: s.userProfile,
      interviewExtractedTasks: s.interviewExtractedTasks,
      setSelectedTasks: s.setSelectedTasks,
      setTaskItems: s.setTaskItems,
      setBonusSnapshot: s.setBonusSnapshot,
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
  const devSkipToReview =
    new URLSearchParams(window.location.search).get("review") === "1";
  const devSkipToCard =
    new URLSearchParams(window.location.search).get("card") === "1";
  const devSkipToHours =
    new URLSearchParams(window.location.search).get("hours") === "1";

  const DEV_REVIEW_SEED: TaskItem[] = [
    {
      name: "Read recent conference papers",
      originalName: "Read recent conference papers",
      status: "confirmed",
    },
    {
      name: "Debug research code",
      originalName: "Debug research code",
      status: "confirmed",
    },
    {
      name: "Meet with my advisor",
      originalName: "Meet with my advisor",
      status: "confirmed",
    },
    {
      name: "Draft a paper section",
      originalName: "Draft a paper section",
      status: "confirmed",
    },
    {
      name: "Present updates at lab meeting",
      originalName: "Present updates at lab meeting",
      status: "confirmed",
    },
    {
      name: "Mentor undergraduate researchers",
      originalName: "Mentor undergraduate researchers",
      status: "confirmed",
    },
    {
      name: "Prepare figures for a manuscript",
      originalName: "Prepare figures for a manuscript",
      status: "confirmed",
    },
  ];

  // Same tasks, but unreviewed, so the per-task card shows the action buttons.
  const DEV_CARD_SEED: TaskItem[] = DEV_REVIEW_SEED.map((t) => ({
    ...t,
    status: "unreviewed",
  }));

  // Same confirmed tasks, but with varied hours so the summary's distribution
  // bars and weekly total render something meaningful.
  const DEV_HOURS_SEED: TaskItem[] = DEV_REVIEW_SEED.map((t, i) => ({
    ...t,
    hoursPerWeek: [8, 5, 2, 6, 3, 4, 1.5][i] ?? 2,
  }));

  const [tasks, setTasks] = useState<TaskItem[]>(
    devSkipToCard
      ? DEV_CARD_SEED
      : devSkipToHours
        ? DEV_HOURS_SEED
        : devSkipToReview
          ? DEV_REVIEW_SEED
          : [],
  );
  const [currentIdx, setCurrentIdx] = useState(
    !devSkipToCard && (devSkipToReview || devSkipToHours)
      ? DEV_REVIEW_SEED.length
      : 0,
  );
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(
    devSkipToReview || devSkipToCard || devSkipToHours ? "ready" : "loading",
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
  useEffect(() => {
    if (devSkipToReview || devSkipToCard || devSkipToHours) return; // dev shortcut: tasks are already seeded
    async function load() {
      try {
        // simple-LLM baseline: the participant's interview-mentioned activities
        // do NOT steer generation. We deliberately do not extract or pass
        // interview tasks; the generator is grounded only by the role profile
        // (and optional retrieval exemplars). The participant's only role is to
        // VALIDATE the generated list in the picker below.
        const interviewTasks: string[] = [];

        // Stream tasks into the picker as they arrive — the participant can
        // start rating the first task in ~1-2s instead of waiting ~7s for the
        // whole list. Attention checks are spliced in inline at the same
        // ATTENTION_CHECK_INTERVAL cadence; the hard 20-item cap still applies.
        // Linear indexing into the (already shuffled) FALLBACK_ATTENTION_CHECKS
        // guarantees no repeats within a session.
        let realCount = 0;
        const onTask = (name: string) => {
          realCount += 1;
          setTasks((prev) => {
            // Stop appending once we've hit the visible cap (real + checks).
            if (prev.length >= MAX_TASKS) return prev;
            const next: TaskItem[] = [
              ...prev,
              { name, originalName: name, status: "unreviewed" },
            ];
            // Splice in an attention check after every Nth real task.
            if (realCount % ATTENTION_CHECK_INTERVAL === 0) {
              const checkIdx = realCount / ATTENTION_CHECK_INTERVAL - 1;
              if (
                checkIdx < FALLBACK_ATTENTION_CHECKS.length &&
                next.length < MAX_TASKS
              ) {
                const label = FALLBACK_ATTENTION_CHECKS[checkIdx];
                next.push({
                  name: label,
                  originalName: label,
                  status: "unreviewed",
                  category: "__attention_check__",
                  isAttentionCheck: true,
                });
              }
            }
            return next;
          });
          // Flip to 'ready' on the first task so the picker shows immediately.
          if (realCount === 1) setLoadState("ready");
        };
        await generateTasksForCategoryStream(
          userProfile.jobTitle,
          userProfile.typicalWeek,
          [],
          userProfile.aiUsage,
          userProfile.responsibilities,
          interviewTasks,
          onTask,
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
  // hours-distribution confirmation screen (instead of finalizing directly).
  const goToHoursSummary = (pendingExtra?: string) => {
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

  // Step 2: finalize the response after the participant confirms their hours.
  const finalize = () => {
    const finalExtras = extraTasks;

    // Tasks the participant typed in get appended as confirmed, flagged as participant-added.
    const extraItems: TaskItem[] = finalExtras.map((e) => ({
      name: e.name,
      originalName: e.name,
      status: "confirmed",
      category: "__participant_added__",
      addedByParticipant: true,
      hoursPerWeek: e.hoursPerWeek,
      edits: [
        { from: "", to: e.name, charsChanged: e.name.length, timestamp: e.addedAt },
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
    return <IntroScreen onStart={() => setShowIntro(false)} totalParts={totalParts} />;
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
          {BONUS_ENABLED && !isExhausted && (editChars > 0 || aiHowSoChars > 0) && (
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

      {/* Task area — top-aligned for the review screen (lots of content),
          centered for the per-task review (single card). */}
      <div
        className={`relative z-10 flex-1 flex flex-col min-h-0 overflow-y-auto
        ${isExhausted ? "justify-start pt-6 pb-12 px-4 sm:px-6" : "justify-center px-8"}`}
      >
        {loading ? (
          <div className="flex justify-center">
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
          <TaskReviewCard
            key={currentIdx}
            task={currentTask}
            taskIdx={currentIdx}
            isLast={currentIdx >= tasks.length - 1}
            onSaveEdit={saveEdit}
            onAdvance={advance}
          />
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

function IntroScreen({ onStart, totalParts }: { onStart: () => void; totalParts: number }) {
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
            Next, we'll go through a list of tasks.
          </h2>
          <p
            className="text-slate-500 mt-6 text-[15px] leading-[1.7] animate-fadeSlideUp"
            style={{ animationDelay: "160ms" }}
          >
            We'll show you a list of tasks someone in your role might do at
            work, and we'll ask you to confirm which tasks you do.
          </p>
          <div className="mt-12 space-y-4">
            <div
              className="px-5 py-4 rounded-xl border border-indigo-100 bg-indigo-50/60 animate-fadeSlideUp"
              style={{ animationDelay: "240ms" }}
            >
              <div className="text-sm leading-[1.6]">
                <p className="font-semibold text-indigo-700 mb-1.5">
                  Attention checks
                </p>
                <p className="text-slate-600">
                  A few items are mixed in to confirm you're reading carefully.
                  Answer everything honestly.
                </p>
              </div>
            </div>
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
            <div
              className="px-5 py-4 rounded-xl border border-amber-200 bg-amber-50 animate-fadeSlideUp"
              style={{ animationDelay: "370ms" }}
            >
              <div className="text-sm leading-[1.6]">
                <p className="font-semibold text-amber-700 mb-1.5">
                  AI-use description
                </p>
                <p className="text-slate-700">
                  For tasks where you use AI, tell us how — what you use it for,
                  in what context. The more specific, the better.
                </p>
                {BONUS_ENABLED && (
                  <p className="mt-2.5 text-amber-800">
                    <span className="font-semibold">
                      {formatUsd(AI_HOWSO_BONUS_PER_CHAR_USD * 1000)} per 1,000
                      characters
                    </span>{" "}
                    on AI-use descriptions.
                  </p>
                )}
              </div>
            </div>
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

// Blue → violet → magenta gradient across N segments. The same function colors
// both the stacked bar segment and its legend dot, so they stay in sync.
function segmentColor(i: number, n: number): string {
  const t = n <= 1 ? 0 : i / (n - 1);
  const hue = 222 + t * 108; // 222 (indigo-blue) → 330 (pink)
  return `hsl(${hue}, 68%, 62%)`;
}

// One editable legend entry: color swatch, task name, and a compact hours input.
// Keeps the raw input text locally so the field can be empty / mid-typing without
// the parent forcing it back to a number.
function LegendRow({
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
  const [text, setText] = useState(
    hours === undefined ? "" : formatHours(hours),
  );
  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <span
        className="w-2.5 h-2.5 rounded-sm shrink-0"
        style={{ background: color }}
      />
      <p
        className="flex-1 min-w-0 text-sm text-slate-700 truncate"
        title={name}
      >
        {name}
        {badge && (
          <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wider text-indigo-400">
            {badge}
          </span>
        )}
      </p>
      <input
        type="number"
        min={0}
        step={0.5}
        inputMode="decimal"
        value={text}
        onChange={(e) => {
          const v = e.target.value;
          setText(v);
          const parsed = parseFloat(v);
          onChange(Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined);
        }}
        placeholder="—"
        className="w-14 px-2 py-1 text-sm text-right text-slate-700 placeholder:text-slate-300 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300 transition"
      />
      <span className="text-xs text-slate-400 w-3">h</span>
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
        <div className="w-full max-w-2xl mx-auto animate-fadeSlideIn">
          <h2 className="text-[1.5rem] font-light text-slate-800 leading-snug tracking-tight">
            Your week at a glance
          </h2>
          <p className="text-sm text-slate-500 mt-2 leading-relaxed">
            Here's how your hours add up across tasks. Adjust any that look off.
          </p>

          {/* Total + stacked distribution bar + legend — one combined block */}
          <div className="mt-6 px-5 py-5 rounded-2xl bg-slate-50/70 border border-slate-100">
            {/* Total headline */}
            <div className="flex items-baseline gap-2.5">
              <span className="text-3xl font-semibold text-indigo-600">
                {formatHours(total)} h
              </span>
              <span className="text-sm text-slate-400">
                weekly total across {taskCount} task
                {taskCount !== 1 ? "s" : ""}
              </span>
            </div>

            {/* Stacked proportional bar */}
            <div className="mt-4 flex w-full h-14 rounded-xl overflow-hidden bg-slate-100">
              {total > 0 ? (
                items.map((it, i) => {
                  const pct = ((it.hours ?? 0) / total) * 100;
                  if (pct <= 0) return null;
                  return (
                    <div
                      key={it.key}
                      className="flex items-center justify-center text-white text-sm font-medium border-r-2 border-white last:border-r-0 overflow-hidden whitespace-nowrap"
                      style={{ width: `${pct}%`, background: segmentColor(i, n) }}
                      title={`${it.name}: ${formatHours(it.hours ?? 0)}h`}
                    >
                      {pct >= 7 ? formatHours(it.hours ?? 0) : ""}
                    </div>
                  );
                })
              ) : (
                <div className="flex items-center justify-center w-full text-xs text-slate-400">
                  Enter hours below to see your week
                </div>
              )}
            </div>

            {/* Legend — editable */}
            <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-x-8">
              {items.map((it, i) => (
                <LegendRow
                  key={it.key}
                  name={it.name}
                  hours={it.hours}
                  color={segmentColor(i, n)}
                  badge={it.badge}
                  onChange={it.onChange}
                />
              ))}
            </div>
          </div>

          {hint && (
            <p className="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              {hint}
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
  onSaveEdit: (idx: number, name: string) => void;
  onAdvance: (answer: "yes" | "no", meta?: { hoursPerWeek: number }) => void;
}

function TaskReviewCard({
  task,
  taskIdx,
  isLast,
  onSaveEdit,
  onAdvance,
}: TaskReviewCardProps) {
  const [primaryAnswer, setPrimaryAnswer] = useState<"yes" | "no" | null>(null);
  // Self-reported hours/week on this task — only collected when "I do this".
  // Stored as the raw input string so the field can be empty mid-typing; parsed
  // to a number on continue.
  const [hoursInput, setHoursInput] = useState("");
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(task.name);
  // One-time nudge on the very first task pointing at the editable name.
  const [showEditNudge, setShowEditNudge] = useState(taskIdx === 0);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Dismiss the nudge once the participant has either started editing or
  // committed to an answer — they've absorbed the affordance.
  useEffect(() => {
    if (editing || primaryAnswer) setShowEditNudge(false);
  }, [editing, primaryAnswer]);

  const hoursValue = parseFloat(hoursInput);
  const hoursValid = Number.isFinite(hoursValue) && hoursValue >= 0;
  // "No" continues immediately; "Yes" requires a valid hours figure.
  const canContinue =
    primaryAnswer === "no" || (primaryAnswer === "yes" && hoursValid);

  const handleContinue = () => {
    if (!canContinue) return;
    if (primaryAnswer === "no") {
      onAdvance("no");
    } else {
      onAdvance("yes", { hoursPerWeek: hoursValue });
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
    <div className="flex flex-col gap-7">
      {/* First-task nudge: pops in shortly after the task card lands. Tells
          participants the task name is editable. Dismisses once they start
          editing or pick an answer. */}
      {showEditNudge && !editing && (
        <div className="-mb-4 animate-popIn">
          <div className="relative inline-flex items-start gap-2 max-w-sm px-3.5 py-2.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-xs leading-relaxed">
            <svg
              className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-600"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M14 4l2 2-9 9-3 1 1-3 9-9z" />
            </svg>
            <span>
              <span className="font-semibold">Tip:</span> To edit the task
              statement, hover the text below and click to edit it.
            </span>
            <button
              type="button"
              onClick={() => setShowEditNudge(false)}
              aria-label="Dismiss tip"
              className="ml-1 -mr-1 -mt-0.5 w-5 h-5 flex items-center justify-center rounded-full text-amber-500 hover:bg-amber-100 hover:text-amber-700 transition shrink-0"
            >
              <svg
                viewBox="0 0 20 20"
                className="w-3 h-3"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
              >
                <line x1="6" y1="6" x2="14" y2="14" />
                <line x1="14" y1="6" x2="6" y2="14" />
              </svg>
            </button>
            {/* Down-arrow connector pointing at the task name below */}
            <span className="absolute -bottom-1.5 left-5 w-3 h-3 rotate-45 bg-amber-50 border-b border-r border-amber-200" />
          </div>
        </div>
      )}

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
          <div className="group">
            <p className="text-2xl font-light text-slate-800 leading-snug">
              {task.name}
            </p>
            <p className="text-xs text-slate-300 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
              click to edit
            </p>
          </div>
        )}
      </div>

      {/* Primary answer */}
      <div className="flex gap-3">
        {[
          {
            value: "yes" as const,
            label: "I do this",
            active:
              "bg-indigo-600 border-indigo-600 text-white shadow-sm shadow-indigo-200",
            inactive: "hover:border-indigo-200 hover:text-indigo-600",
          },
          {
            value: "no" as const,
            label: "I don't do this",
            active: "bg-slate-100 border-slate-300 text-slate-700",
            inactive: "hover:border-slate-300",
          },
        ].map(({ value, label, active, inactive }) => (
          <button
            key={value}
            onClick={() => {
              setPrimaryAnswer(value);
              if (value === "no") setHoursInput("");
            }}
            className={`flex-1 py-3 rounded-2xl border text-sm font-medium transition-all active:scale-[0.98] ${primaryAnswer === value ? active : `bg-white border-slate-200 text-slate-600 ${inactive}`}`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Hours follow-up — only when the participant does this task */}
      {primaryAnswer === "yes" && (
        <div className="space-y-5 pt-2 animate-fadeSlideIn">
          <p className="text-base font-normal text-slate-500">
            In a typical week, how many hours do you spend on this?
          </p>
          <div className="flex items-center gap-3">
            <input
              type="number"
              min={0}
              step={0.5}
              inputMode="decimal"
              autoFocus
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

          <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
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
            Earn {formatUsd(ADD_BONUS_PER_TASK_USD)} for each task you add, up to{" "}
            {formatUsd(ADD_BONUS_MAX_USD)}.
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
