import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  generateTasksFromInterview,
  generateAttentionChecks,
  extractInterviewTasks,
  recordScreenOut,
  transcribeAudio,
} from "../lib/api";
import { useWorkflowStore } from "../store";
import { BONUS_ENABLED } from "../lib/bonus";
import { TaskItem, TaskRelevance } from "../types";

// Master switch for the hours feature: the per-task "how many hours" question
// AND the "Your week at a glance" summary screen. Flip to false to drop both —
// the flow then goes review/add → finalize with no hours collected.
const HOURS_ENABLED = false;

// Master switch for the per-task control. When false, each card shows the binary
// "I do this / I don't do this". When true, it shows a 5-point relevance rating
// of the task to the occupation. The granular choice is stored on
// TaskItem.relevance; downstream keep/drop and the active-learning write-back
// still key off whether the choice maps to "yes" (only 'relevant') vs "no".
const RELEVANCE_RATING_ENABLED = false;

// Relevance options in display order. `answer` is the binary the choice maps to
// for the existing keep/drop + confirm/deny write-back logic.
const RELEVANCE_OPTIONS: {
  value: TaskRelevance;
  label: string;
  answer: "yes" | "no";
}[] = [
  { value: "relevant", label: "Yes, currently relevant", answer: "yes" },
  {
    value: "future",
    label: "Not yet, but likely within 5 years",
    answer: "no",
  },
  {
    value: "other-occupation",
    label: "No, performed by workers in a different occupation",
    answer: "no",
  },
  { value: "not-valid", label: "No, not valid or practical", answer: "no" },
  { value: "unsure", label: "Unsure", answer: "no" },
];

// Ceiling on the generated list. We show ALL the participant's tasks — no
// artificial max or min — so nothing they described gets dropped; this only
// bounds pathological runs. The server caps the model at this and emits
// everything it produces under it.
const GENERATION_CEILING = 40;

// Number of cards the participant must rate before the "Finish early" escape
// unlocks — a burnout valve, independent of how long the full list is.
const DONE_THRESHOLD = 15;

// Master switch for attention checks. When false, none are fetched or spliced
// into the picker (and the real-task budget reclaims their slots), so the
// fail/screen-out path in advance() can never trigger.
const ATTENTION_CHECKS_ENABLED = false;

// Attention checks: O*NET-style tasks from clearly unrelated occupations,
// spliced into the picker. Any honest participant marks them "I don't do this";
// answering "yes" counts as a fail (see advance()). When enabled they splice in
// on top of the full generated list.
const ATTENTION_CHECK_COUNT = ATTENTION_CHECKS_ENABLED ? 2 : 0;

// Used when the LLM call fails or returns too few items — guarantees the picker
// still carries attention checks. Each is a real task from an occupation with no
// overlap with knowledge/office work.
const FALLBACK_ATTENTION_CHECKS: string[] = [
  "Replace worn brake pads and rotors on a customer's vehicle, then road-test it to confirm the repair.",
  "Administer prescribed vaccines to patients and record each dose in their medical chart.",
  "Inspect overhead power lines from a bucket truck and replace damaged insulators.",
  "Harvest ripe produce by hand and sort it into crates for shipment to distributors.",
  "Cut, bend, and join sheet-metal ducting for a building's heating and cooling system.",
];

// Build TaskItem cards for the attention checks, padding from the fallback list
// when the model returns too few. De-dupes case-insensitively and returns up to
// `count` items.
function buildAttentionCheckItems(
  generated: string[],
  count: number,
): TaskItem[] {
  if (count <= 0) return [];
  const seen = new Set<string>();
  const pool: string[] = [];
  for (const raw of [...generated, ...FALLBACK_ATTENTION_CHECKS]) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    pool.push(name);
    if (pool.length >= count) break;
  }
  return pool.map((name) => ({
    name,
    originalName: name,
    status: "unreviewed" as const,
    isAttentionCheck: true,
  }));
}

// Intersperse attention checks among the real tasks at even intervals, never at
// index 0 (the first card orients the participant) and preferably not trailing.
// Real-task order is preserved.
function spliceAttentionChecks(
  real: TaskItem[],
  checks: TaskItem[],
): TaskItem[] {
  if (checks.length === 0) return real;
  if (real.length <= 1) return [...real, ...checks];
  const interval = Math.max(1, Math.floor(real.length / (checks.length + 1)));
  const out: TaskItem[] = [];
  let ci = 0;
  for (let i = 0; i < real.length; i++) {
    out.push(real[i]);
    if (ci < checks.length && (i + 1) % interval === 0 && i + 1 < real.length) {
      out.push(checks[ci++]);
    }
  }
  // Safety net: append any checks the interval math didn't place.
  while (ci < checks.length) out.push(checks[ci++]);
  return out;
}

// The "Make it yours" edit nudge stays hidden until the participant has passed
// this many task cards without editing any task name. Once they edit any task,
// the nudge stops appearing for the rest of the flow.
const NUDGE_AFTER_UNEDITED = 3;

// Confirmed tasks (with per-task hours) seeded for the ?dev=task-selection&hours=1
// preview so the hours breakdown has content without running the real pipeline.
// Their sum (17h) deliberately differs from the seeded weekly total (40h) so the
// "Rescale to match" note shows.
const DEV_HOURS_SEED: TaskItem[] = [
  {
    name: "Build and ship UI components",
    originalName: "Build and ship UI components",
    status: "confirmed",
    hoursPerWeek: 6,
  },
  {
    name: "Review pull requests",
    originalName: "Review pull requests",
    status: "confirmed",
    hoursPerWeek: 4,
  },
  {
    name: "Debug production issues",
    originalName: "Debug production issues",
    status: "confirmed",
    hoursPerWeek: 3,
  },
  {
    name: "Write integration tests",
    originalName: "Write integration tests",
    status: "confirmed",
    hoursPerWeek: 2.5,
  },
  {
    name: "Sync with design",
    originalName: "Sync with design",
    status: "confirmed",
    hoursPerWeek: 1.5,
  },
  {
    name: "Plan the sprint and groom the backlog",
    originalName: "Plan the sprint and groom the backlog",
    status: "confirmed",
    hoursPerWeek: 2,
  },
  {
    name: "Pair with teammates on tricky features",
    originalName: "Pair with teammates on tricky features",
    status: "confirmed",
    hoursPerWeek: 3,
  },
  {
    name: "Update technical documentation",
    originalName: "Update technical documentation",
    status: "confirmed",
    hoursPerWeek: 1,
  },
  {
    name: "Investigate and triage bug reports",
    originalName: "Investigate and triage bug reports",
    status: "confirmed",
    hoursPerWeek: 2,
  },
  {
    name: "Mentor junior engineers",
    originalName: "Mentor junior engineers",
    status: "confirmed",
    hoursPerWeek: 1.5,
  },
];

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
    setSelectedTasks,
    setTaskItems,
    setBonusSnapshot,
    setInterviewExtractedTasks,
    setPhase,
    prolific,
    setProlific,
    avgWeeklyHours,
    setAvgWeeklyHours,
  } = useWorkflowStore(
    useShallow((s) => ({
      userProfile: s.userProfile,
      backgroundTranscript: s.backgroundTranscript,
      setSelectedTasks: s.setSelectedTasks,
      setTaskItems: s.setTaskItems,
      setBonusSnapshot: s.setBonusSnapshot,
      setInterviewExtractedTasks: s.setInterviewExtractedTasks,
      setPhase: s.setPhase,
      prolific: s.prolific,
      setProlific: s.setProlific,
      avgWeeklyHours: s.avgWeeklyHours,
      setAvgWeeklyHours: s.setAvgWeeklyHours,
    })),
  );

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

  const [tasks, setTasks] = useState<TaskItem[]>(
    devSkipToHours ? DEV_HOURS_SEED : [],
  );
  const [currentIdx, setCurrentIdx] = useState(0);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const devSkip = devSkipToReview || devSkipToCard || devSkipToHours;
  const [showProcessing, setShowProcessing] = useState(!devSkip);
  const [showIntro, setShowIntro] = useState(false);
  const [showEditPopup, setShowEditPopup] = useState(false);
  const editPopupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  // Dev preview: when jumping straight to the breakdown (&step=breakdown), seed
  // a weekly total so the "Rescale" note renders. NOT seeded for the plain
  // hours=1 link, so the step-1 question still starts empty.
  useEffect(() => {
    if (
      devSkipToHours &&
      _search.get("step") === "breakdown" &&
      avgWeeklyHours == null
    ) {
      setAvgWeeklyHours(40);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Kick off task load immediately (runs during intro screen).
  // We skip the domain-generation step and ask the model directly for a breadth-spanning
  // set of tasks for this role. Faster (one LLM call instead of N+1) and the model handles
  // breadth on its own when told to.
  const didLoadRef = useRef(false);
  useEffect(() => {
    if (devSkip) {
      setShowIntro(true);
      return;
    }
    if (didLoadRef.current) return;
    didLoadRef.current = true;
    async function load() {
      // Keep the "Processing your interview…" screen up for the whole
      // extraction + generation pass, with a 1.2s floor so it never flashes.
      const minDisplay = new Promise((r) => setTimeout(r, 1200));
      try {
        // Extract interview tasks first (grounding for generation).
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

        // Kick off attention-check generation in parallel with the real task
        // stream so it adds no latency to the processing screen. Fail-open:
        // buildAttentionCheckItems pads from the fallback list if this rejects
        // or returns too few. Request a couple extra for de-dupe headroom.
        // Skipped entirely when attention checks are disabled.
        const attnPromise = ATTENTION_CHECKS_ENABLED
          ? generateAttentionChecks(
              userProfile.jobTitle,
              userProfile.responsibilities,
              userProfile.typicalWeek,
              ATTENTION_CHECK_COUNT + 2,
            ).catch((e) => {
              console.warn(
                "[task-selection] attention-check fetch failed, using fallback:",
                e,
              );
              return [] as string[];
            })
          : Promise.resolve([] as string[]);

        // Generate the full rewritten task list while the processing screen
        // stays up, so the participant only reaches the cards once every task is
        // ready. We show ALL the generated tasks — no max/min cap — so nothing
        // they described gets dropped. (When attention checks are on, they
        // splice in on top below.)
        let realCount = 0;
        const onTask = (
          name: string,
          meta?: {
            source?: "interview" | "gap";
          },
        ) => {
          realCount += 1;
          setTasks((prev) => [
            ...prev,
            {
              name,
              originalName: name,
              source: meta?.source,
              status: "unreviewed",
            },
          ]);
          if (realCount === 1) setLoadState("ready");
        };
        await generateTasksFromInterview(
          userProfile.jobTitle,
          userProfile.typicalWeek,
          userProfile.responsibilities,
          interviewTasks,
          (name, meta) => onTask(name, meta),
          GENERATION_CEILING,
          prolific.pid || useWorkflowStore.getState().sessionId,
        );
        // If the stream returned zero tasks (model fluke), surface an error
        // state so the participant sees something rather than a frozen loader.
        if (realCount === 0) setLoadState("error");

        // Splice the attention checks into the generated list at even intervals.
        const attnItems = buildAttentionCheckItems(
          await attnPromise,
          ATTENTION_CHECK_COUNT,
        );
        if (attnItems.length > 0) {
          setTasks((prev) => spliceAttentionChecks(prev, attnItems));
        }
      } catch (e) {
        console.error("Task load failed", e);
        setLoadState("error");
      } finally {
        // Leave the processing screen only once generation has finished (or
        // failed), and never before the 1.2s minimum.
        await minDisplay;
        setShowProcessing(false);
        setShowIntro(true);
      }
    }
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const saveEdit = (idx: number, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    // Dismiss the edit reminder as soon as any real edit is saved.
    if (trimmed !== tasks[idx]?.name) {
      if (editPopupTimerRef.current) clearTimeout(editPopupTimerRef.current);
      setShowEditPopup(false);
    }
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

  const advance = (
    answer: "yes" | "no",
    meta?: { hoursPerWeek?: number; relevance?: TaskRelevance },
  ) => {
    const reviewedTask = tasks[currentIdx];

    // Per-task dwell time: shownAt was stamped when this card became active.
    const answeredAt = Date.now();
    setTasks((prev) =>
      prev.map((t, i) => {
        if (i !== currentIdx) return t;
        const timed = {
          ...t,
          answeredAt,
          timeSpentMs: t.shownAt != null ? answeredAt - t.shownAt : undefined,
        };
        const withRel = meta?.relevance
          ? { ...timed, relevance: meta.relevance }
          : timed;
        if (answer === "no") return { ...withRel, status: "removed" };
        return {
          ...withRel,
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
            i !== currentIdx
              ? t
              : {
                  ...t,
                  status: "confirmed",
                  answeredAt,
                  timeSpentMs:
                    t.shownAt != null ? answeredAt - t.shownAt : undefined,
                },
          ),
        );
        setPhase("screen-out");
        return;
      }
    }

    setCurrentIdx((i) => {
      const next = i + 1;
      // Re-show the edit reminder on every card after the threshold, until
      // the participant edits at least one task.
      if (next >= NUDGE_AFTER_UNEDITED) {
        const hasEdited = tasks.some((t) => (t.edits?.length ?? 0) > 0);
        if (!hasEdited) {
          if (editPopupTimerRef.current)
            clearTimeout(editPopupTimerRef.current);
          setShowEditPopup(true);
          editPopupTimerRef.current = setTimeout(
            () => setShowEditPopup(false),
            4000,
          );
        } else {
          setShowEditPopup(false);
        }
      }
      return next;
    });
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
    // selectedTasks is the participant's real confirmed work — never an
    // attention check (one answered "yes" carries status "confirmed" but must
    // not pollute the list). It's still retained in taskItems with its status.
    const confirmed = allTasks
      .filter(
        (t) =>
          (t.status === "confirmed" || t.status === "edited") &&
          !t.isAttentionCheck,
      )
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

    // This study has no Part-3 priority/workflow phases, so every condition goes
    // straight to the final feedback questions. (Routing the default 'full'
    // condition to 'task-priority' dead-ended at StudyComplete — App.tsx has no
    // renderer for that phase — silently skipping the feedback form.)
    setPhase("final-questions");
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

  // Per-task timing: stamp shownAt the first time a card becomes the active
  // question (answeredAt + timeSpentMs are set in advance()). cardActive gates
  // out the processing/intro/hours screens where no card is visible; the
  // shownAt == null guard makes it idempotent across re-renders.
  const cardActive =
    !showProcessing &&
    !showIntro &&
    !showHoursSummary &&
    !!currentTask &&
    !isExhausted;
  useEffect(() => {
    if (!cardActive) return;
    setTasks((prev) =>
      prev.map((t, i) =>
        i === currentIdx && t.shownAt == null
          ? { ...t, shownAt: Date.now() }
          : t,
      ),
    );
  }, [cardActive, currentIdx]);

  if (showProcessing) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-5 px-8">
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
          Processing your interview…
        </p>
      </div>
    );
  }

  if (showIntro) {
    return <IntroScreen onStart={() => setShowIntro(false)} />;
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
        confirmedPickerTasks={confirmedPickerTasks}
        extraTasks={extraTasks}
        avgWeeklyHours={avgWeeklyHours}
        onSetAvgWeeklyHours={setAvgWeeklyHours}
        onSetTaskHours={setTaskHours}
        onSetExtraHours={setExtraHours}
        onAddTask={addExtraTask}
        onConfirm={finalize}
        initialStep={
          _search.get("step") === "breakdown" ? "breakdown" : "total"
        }
      />
    );
  }

  return (
    <div className="flex flex-col h-full bg-transparent relative overflow-hidden">
      {/* Top gradient is rendered by the parent (App.tsx) so it spans the full viewport. */}

      {/* Edit reminder toast — slides in once after NUDGE_AFTER_UNEDITED unedited cards */}
      <div
        className={`absolute bottom-8 left-6 right-6 z-50 transition-all duration-500 ${showEditPopup ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4 pointer-events-none"}`}
      >
        <div className="bg-slate-800 text-white rounded-2xl px-5 py-4 shadow-lg flex items-start gap-3">
          <svg
            className="w-4 h-4 mt-0.5 shrink-0 text-indigo-300"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M11 2l3 3-8 8H3v-3l8-8z" />
          </svg>
          <p className="text-sm leading-relaxed">
            <span className="font-semibold text-white">
              Quick reminder: Use the pencil to edit.
            </span>{" "}
            <span className="text-slate-300">
              Rewrite any task that doesn't quite fit.
            </span>
          </p>
        </div>
      </div>

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
      <div
        className={`relative z-10 px-5 sm:px-8 pt-7 sm:pt-8 pb-5 shrink-0 w-full mx-auto ${
          isExhausted ? "max-w-[1000px]" : "max-w-[780px]"
        }`}
      >
        <div className="flex items-center justify-between mb-6">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-indigo-400">
            Task Review
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
          {/* Linear progress over the full generated list (variable length).
              isExhausted pegs to 100% on the last card. */}
          <div
            className="h-full rounded-full bg-gradient-to-r from-indigo-400 to-violet-400 transition-all duration-500 ease-out"
            style={{
              width: `${isExhausted || tasks.length === 0 ? 100 : Math.min((currentIdx / tasks.length) * 100, 100)}%`,
            }}
          />
        </div>
      </div>

      {/* Task area */}
      <div
        className={`relative z-10 flex-1 flex flex-col min-h-0 overflow-y-auto w-full mx-auto
        ${isExhausted ? "justify-start pt-6 pb-[48vh] px-5 sm:px-8 max-w-[860px]" : "px-5 sm:px-8 max-w-[780px]"}`}
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
            extraTasks={extraTasks}
            extraInput={extraInput}
            onExtraInputChange={setExtraInput}
            onAddExtra={addExtraTask}
            onRemoveExtra={removeExtraTask}
            onRemoveConfirmed={(idx) =>
              setTasks((prev) => {
                const confirmed = prev.filter(
                  (x) =>
                    (x.status === "confirmed" || x.status === "edited") &&
                    !x.isAttentionCheck,
                );
                const target = confirmed[idx];
                return prev.filter((t) => t !== target);
              })
            }
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
              onSaveEdit={saveEdit}
              onAdvance={advance}
            />
          </div>
        ) : null}
      </div>

      {/* Footer — early-exit hint, only shown mid-flow (the exhausted screen has its own primary button) */}
      {canEarlyExit && !isExhausted && (
        <div className="relative z-10 px-5 sm:px-8 pb-8 pt-4 border-t border-slate-100 shrink-0 w-full max-w-[780px] mx-auto">
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

function IntroScreen({ onStart }: { onStart: () => void }) {
  return (
    <div className="flex flex-col h-full bg-transparent relative overflow-hidden">
      {/* Top gradient is rendered by the parent (App.tsx) so it spans the full viewport. */}
      <div className="relative z-10 flex flex-1 items-center justify-center px-5 sm:px-8 py-10 overflow-y-auto">
        <div className="max-w-lg w-full">
          <p
            className="text-[10px] font-semibold uppercase tracking-[0.18em] text-indigo-400 mb-9 animate-fadeSlideUp"
            style={{ animationDelay: "0ms" }}
          >
            Task Review
          </p>
          <h2
            className="text-[1.4rem] sm:text-[1.65rem] font-light text-slate-800 leading-snug tracking-tight animate-fadeSlideUp"
            style={{ animationDelay: "80ms" }}
          >
            Let's check what we heard.
          </h2>
          <p
            className="text-slate-500 mt-6 text-[15px] leading-[1.7] animate-fadeSlideUp"
            style={{ animationDelay: "160ms" }}
          >
            From your interview, we pulled together the tasks below. This step
            is just to make sure we captured your work correctly.
          </p>
          <p
            className="text-slate-500 mt-4 text-[15px] leading-[1.7] animate-fadeSlideUp"
            style={{ animationDelay: "220ms" }}
          >
            Go through each one: confirm the tasks you actually do, drop the
            ones you don't, and reword anything that doesn't quite match how
            you'd describe it.
          </p>
          <div
            className="mt-6 px-5 py-4 rounded-xl border border-indigo-100 bg-indigo-50/60 animate-fadeSlideUp"
            style={{ animationDelay: "280ms" }}
          >
            <p className="text-sm font-semibold text-indigo-700 mb-1.5">
              Why edit the tasks
            </p>
            <p className="text-sm text-slate-600 leading-relaxed">
              No one understands your work better than you do. Correcting and
              rewording these tasks so they match what you actually do — and how
              you'd describe it — is exactly what helps us get your role right.
            </p>
          </div>
          <div className="mt-6 space-y-4">
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
            className="mt-10 sm:mt-14 inline-flex items-center gap-2 px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-full transition-all active:scale-[0.98] shadow-sm shadow-indigo-200 animate-fadeSlideUp"
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
  confirmedPickerTasks,
  extraTasks,
  avgWeeklyHours,
  onSetAvgWeeklyHours,
  onSetTaskHours,
  onSetExtraHours,
  onAddTask,
  onConfirm,
  initialStep = "total",
}: {
  confirmedPickerTasks: { t: TaskItem; idx: number }[];
  extraTasks: { name: string; addedAt: number; hoursPerWeek?: number }[];
  avgWeeklyHours: number | null;
  onSetAvgWeeklyHours: (hours: number | null) => void;
  onSetTaskHours: (idx: number, hours: number | undefined) => void;
  onSetExtraHours: (idx: number, hours: number | undefined) => void;
  onAddTask: (name: string) => void;
  onConfirm: () => void;
  initialStep?: "total" | "breakdown";
}) {
  const [addInput, setAddInput] = useState("");
  const submitAdd = () => {
    const t = addInput.trim();
    if (!t) return;
    onAddTask(t);
    setAddInput("");
  };
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
  // The total-hours question is its own first step; the per-task breakdown is
  // the second. Always start on the question so it's asked before the breakdown.
  const avgValid = typeof avgWeeklyHours === "number" && avgWeeklyHours > 0;
  const [hoursStep, setHoursStep] = useState<"total" | "breakdown">(
    initialStep,
  );

  // Seed the breakdown so the per-task hours sum EXACTLY to the weekly total the
  // participant entered in step 1. Each task keeps its share of the per-task
  // hours collected on the cards (or an even split if none were given), scaled
  // to the total and rounded to half-hours via largest-remainder so the rounded
  // values still add up to the target. Runs once, when advancing to step 2; they
  // can fine-tune freely after.
  const normalizeHoursToTotal = () => {
    if (!avgValid || items.length === 0) return;
    const targetUnits = Math.round((avgWeeklyHours as number) * 2); // half-hour units
    if (targetUnits <= 0) return;
    const currentSum = items.reduce((s, it) => s + (it.hours ?? 0), 0);
    const weights = items.map((it) =>
      currentSum > 0 ? (it.hours ?? 0) / currentSum : 1 / items.length,
    );
    const raw = weights.map((w) => w * targetUnits);
    const units = raw.map((r) => Math.floor(r));
    let leftover = targetUnits - units.reduce((s, u) => s + u, 0);
    // Hand out the remaining half-hour units to the largest fractional parts.
    raw
      .map((r, i) => ({ i, frac: r - Math.floor(r) }))
      .sort((a, b) => b.frac - a.frac)
      .forEach(({ i }) => {
        if (leftover > 0) {
          units[i] += 1;
          leftover -= 1;
        }
      });
    items.forEach((it, i) => it.onChange(units[i] / 2));
  };

  return (
    <div className="flex flex-col h-full bg-transparent relative overflow-hidden">
      {/* Header */}
      <div className="relative z-10 px-5 sm:px-8 pt-7 sm:pt-8 pb-5 shrink-0">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-indigo-400 mb-4">
          Time breakdown
        </p>
      </div>

      {hoursStep === "total" ? (
        <div className="relative z-10 flex-1 flex flex-col min-h-0 overflow-y-auto py-12 px-5 sm:px-8">
          {/* my-auto centers when short; collapses to scroll when tall. */}
          <div className="w-full my-auto animate-fadeSlideIn">
            <div className="text-center max-w-xl mx-auto">
              {/* Step 1 — total weekly hours, asked first and on its own. */}
              <h2 className="text-[1.5rem] font-light text-slate-800 leading-snug tracking-tight">
                In an average week, how many hours do you work?
              </h2>
              <p className="text-sm text-slate-500 mt-2 leading-relaxed">
                Your best estimate of total hours across all your work in a
                typical week.
              </p>
              <div className="mt-6 flex items-center justify-center gap-3">
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step={0.5}
                  value={avgWeeklyHours ?? ""}
                  onChange={(e) => {
                    const v = e.target.value.trim();
                    if (v === "") return onSetAvgWeeklyHours(null);
                    const parsed = parseFloat(v);
                    onSetAvgWeeklyHours(
                      Number.isFinite(parsed) && parsed >= 0 ? parsed : null,
                    );
                  }}
                  placeholder=""
                  className="w-28 rounded-xl border border-slate-200 bg-white px-4 py-3 text-lg text-center text-slate-800 tabular-nums transition focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-200"
                />
                <span className="text-sm text-slate-500">hours / week</span>
              </div>

              <div className="mt-8 flex justify-center">
                <button
                  onClick={() => setHoursStep("breakdown")}
                  disabled={!avgValid}
                  className="shrink-0 inline-flex items-center gap-2 px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-30 disabled:cursor-not-allowed text-white text-sm font-medium rounded-full transition-all active:scale-[0.98] shadow-sm shadow-indigo-200"
                >
                  Continue
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="relative z-10 flex-1 flex flex-col min-h-0 overflow-y-auto w-full max-w-4xl mx-auto px-5 sm:px-8 animate-fadeSlideIn">
          {/* my-auto centers the whole block vertically when it fits the panel,
              and collapses to scroll when the task list is long. */}
          <div className="my-auto w-full py-4">
            {/* Heading + total bar */}
            <div className="pb-4">
              <h2 className="text-[1.5rem] font-light text-slate-800 leading-snug tracking-tight">
                Your week at a glance
              </h2>
              <p className="text-sm text-slate-500 mt-2 leading-relaxed">
                Here's how your hours add up across tasks. Drag a bar for a
                quick estimate, then use −/+ to fine-tune to the half hour.
              </p>

              {/* Total pill + stacked breakdown bar */}
              <div className="mt-6 px-6 py-5 rounded-2xl bg-indigo-50/70">
                <div>
                  <span className="text-3xl font-semibold text-indigo-600 tabular-nums align-middle">
                    {formatHours(total)}
                  </span>
                  <span className="ml-2 text-sm text-slate-500 align-middle">
                    hours / week across {taskCount} task
                    {taskCount !== 1 ? "s" : ""}
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
            </div>

            {/* Task rows + footer flow together under the bar. */}
            <div>
              <div className="divide-y divide-slate-100">
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

              {/* Footer — add-a-missed-task + Continue, just below the rows. */}
              <div className="pt-4 pb-4 mt-2 border-t border-slate-100">
                {/* Add a task they only thought of now — feeds the same added-task
                flow, then needs its own hours set before they can continue. The
                add action is embedded in the field (matches the review screen's
                mic affordance) so it reads as one compact control. */}
                <div className="relative">
                  <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-300">
                    <svg
                      className="w-4 h-4"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </span>
                  <input
                    type="text"
                    value={addInput}
                    onChange={(e) => setAddInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        submitAdd();
                      }
                    }}
                    placeholder="Add a task we missed…"
                    className="w-full pl-10 pr-24 py-3 text-sm text-slate-700 placeholder:text-slate-400 bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300 transition"
                  />
                  <button
                    type="button"
                    onClick={submitAdd}
                    disabled={!addInput.trim()}
                    className="absolute right-2 top-1/2 -translate-y-1/2 px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-30 disabled:cursor-not-allowed text-white text-xs font-medium rounded-lg transition-all active:scale-[0.97]"
                  >
                    Add
                  </button>
                </div>

                {/* Over/under-budget warning — the per-task hours don't sum to the
                weekly total they stated. One-click rescale, or add a task above. */}
                {avgValid &&
                  Math.abs(total - (avgWeeklyHours as number)) >= 0.5 && (
                    <div className="mt-4 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                      <div className="flex items-start gap-2">
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
                        <p className="text-sm text-amber-800 leading-relaxed">
                          You said about{" "}
                          <span className="font-semibold">
                            {formatHours(avgWeeklyHours as number)}
                          </span>{" "}
                          hours/week, but your tasks add up to{" "}
                          <span className="font-semibold">
                            {formatHours(total)}
                          </span>
                          . Rescale them to match, or add a task you missed
                          above.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={normalizeHoursToTotal}
                        className="shrink-0 px-4 py-2.5 bg-white border border-amber-300 text-amber-700 hover:bg-amber-100 text-sm font-medium rounded-lg transition-all active:scale-[0.98]"
                      >
                        Rescale to {formatHours(avgWeeklyHours as number)}
                      </button>
                    </div>
                  )}

                <div className="mt-4 flex items-center justify-end gap-3">
                  {!allFilled && (
                    <p className="text-xs text-slate-400">
                      Enter hours for every task to continue.
                    </p>
                  )}
                  <button
                    onClick={() => onConfirm()}
                    disabled={!allFilled}
                    className="shrink-0 inline-flex items-center gap-2 px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-30 disabled:cursor-not-allowed text-white text-sm font-medium rounded-full transition-all active:scale-[0.98] shadow-sm shadow-indigo-200"
                  >
                    Continue
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Single task review card ────────────────────────────────────────────────────

interface TaskReviewCardProps {
  task: TaskItem;
  taskIdx: number;
  isLast: boolean;
  onSaveEdit: (idx: number, name: string) => void;
  onAdvance: (
    answer: "yes" | "no",
    meta?: { hoursPerWeek?: number; relevance?: TaskRelevance },
  ) => void;
}

function TaskReviewCard({
  task,
  taskIdx,
  isLast,
  onSaveEdit,
  onAdvance,
}: TaskReviewCardProps) {
  const [primaryAnswer, setPrimaryAnswer] = useState<"yes" | "no" | null>(null);
  const [relevanceChoice, setRelevanceChoice] = useState<TaskRelevance | null>(
    null,
  );
  const [hoursInput, setHoursInput] = useState("");
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(task.name);
  const [showCoachMark, setShowCoachMark] = useState(taskIdx === 0);
  // Buttons are locked on card 1 until the participant clicks the pencil.
  const [pencilClicked, setPencilClicked] = useState(taskIdx !== 0);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Dismiss coach mark once they've clicked the pencil
  useEffect(() => {
    if (pencilClicked) setShowCoachMark(false);
  }, [pencilClicked]);

  const hoursValue = parseFloat(hoursInput);
  const hoursValid = Number.isFinite(hoursValue) && hoursValue >= 0;
  // "No" continues immediately; "Yes" requires a valid hours figure only while
  // the hours feature is on.
  const canContinue =
    primaryAnswer === "no" ||
    (primaryAnswer === "yes" && (!HOURS_ENABLED || hoursValid));

  const handleContinue = () => {
    if (!canContinue) return;
    const relMeta = relevanceChoice ? { relevance: relevanceChoice } : {};
    if (primaryAnswer === "no") {
      onAdvance("no", relMeta);
    } else {
      onAdvance("yes", {
        ...(HOURS_ENABLED ? { hoursPerWeek: hoursValue } : {}),
        ...relMeta,
      });
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
        // Place the caret at the end rather than selecting all — selecting all
        // means the first keystroke wipes the statement, which makes small
        // tweaks awkward. End-caret lets the participant edit in place.
        const end = inputRef.current.value.length;
        inputRef.current.setSelectionRange(end, end);
      }
    }, 20);
  };

  const commitEdit = () => {
    setEditing(false);
    const trimmed = editValue.trim() || task.name;
    onSaveEdit(taskIdx, trimmed);
  };

  return (
    <div
      className={
        HOURS_ENABLED
          ? "h-full flex flex-col justify-center gap-6 sm:gap-8 relative"
          : "h-full relative"
      }
    >
      {/* Layout. Binary mode (no hours): task name + buttons are vertically
          centered, with the Continue button absolutely pinned to the bottom; the
          big pb reserves that space so the centering point never shifts. Hours
          mode: the whole group (name + buttons + hours follow-up) is centered
          together via the wrapper above, so the follow-up sits right under the
          buttons instead of being stranded at the bottom. */}
      <div
        className={
          HOURS_ENABLED
            ? "flex flex-col gap-8 sm:gap-10"
            : "h-full flex flex-col justify-center gap-6 sm:gap-7 pb-24 sm:pb-48"
        }
      >
        {/* Task name */}
        <div className="pb-1">
          {editing ? (
            <textarea
              ref={inputRef}
              className="w-full text-xl sm:text-2xl font-light text-slate-800 bg-transparent border-b-2 border-indigo-300 focus:outline-none pb-1 resize-none overflow-hidden leading-snug"
              value={editValue}
              rows={1}
              onChange={(e) => {
                setEditValue(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = e.target.scrollHeight + "px";
              }}
              onBlur={commitEdit}
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
              <p className="text-xl sm:text-2xl font-light text-slate-800 leading-snug flex-1">
                {task.name}
              </p>
              {/* Pencil button — only edit trigger */}
              <div className="relative mt-1 shrink-0">
                {showCoachMark && (
                  <span className="absolute inset-0 rounded-full bg-indigo-400 opacity-30 animate-ping" />
                )}
                <button
                  type="button"
                  onClick={() => {
                    setPencilClicked(true);
                    startEdit();
                  }}
                  className="relative flex items-center justify-center w-8 h-8 rounded-full bg-slate-100 hover:bg-indigo-50 hover:text-indigo-600 text-slate-500 transition-colors"
                  aria-label="Edit task"
                >
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
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Coach mark callout — first card only, blocks buttons until pencil clicked */}
        {showCoachMark && (
          <div className="animate-popIn flex items-start gap-2.5 px-4 py-3 rounded-xl bg-indigo-50 border border-indigo-200 -mt-2">
            <svg
              className="w-3.5 h-3.5 mt-0.5 shrink-0 text-indigo-400"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M11 2l3 3-8 8H3v-3l8-8z" />
            </svg>
            <p className="text-sm text-indigo-700 leading-relaxed">
              <span className="font-semibold">
                Use the pencil to edit the statement.
              </span>{" "}
              Add any specifics, remove what doesn't fit, or rewrite it in your
              own words.
            </p>
          </div>
        )}

        {/* Answer control — relevance rating or the binary, behind the flag */}
        {RELEVANCE_RATING_ENABLED ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-500 leading-relaxed">
              How relevant is this task to your occupation?
            </p>
            <div className="flex flex-col gap-2">
              {RELEVANCE_OPTIONS.map(({ value, label, answer }) => (
                <button
                  key={value}
                  disabled={!pencilClicked}
                  onClick={() => {
                    setRelevanceChoice(value);
                    setPrimaryAnswer(answer);
                    if (answer === "no") setHoursInput("");
                    if (!HOURS_ENABLED) {
                      setTimeout(
                        () => onAdvance(answer, { relevance: value }),
                        220,
                      );
                    }
                  }}
                  className={`w-full text-left px-4 py-3 rounded-2xl border text-sm font-medium transition-all active:scale-[0.99] disabled:opacity-30 disabled:cursor-not-allowed ${
                    relevanceChoice === value
                      ? "bg-indigo-600 border-indigo-600 text-white shadow-sm shadow-indigo-200"
                      : "bg-white border-slate-200 text-slate-600 hover:border-indigo-200 hover:text-indigo-600"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        ) : (
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
                disabled={!pencilClicked}
                onClick={() => {
                  setPrimaryAnswer(value);
                  if (value === "no") setHoursInput("");
                  if (!HOURS_ENABLED) {
                    setTimeout(
                      () => onAdvance(value === "no" ? "no" : "yes"),
                      220,
                    );
                  }
                }}
                className={`flex-1 py-3 rounded-2xl border text-sm font-medium transition-all active:scale-[0.98] disabled:opacity-30 disabled:cursor-not-allowed ${
                  primaryAnswer === value
                    ? active
                    : `bg-white border-slate-200 text-slate-600 ${inactive}`
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      {/* end primary section */}

      {/* Hours follow-up + Continue. In hours mode this flows directly under the
          buttons; in binary mode it's empty (buttons auto-advance) so it stays
          absolutely pinned and never disturbs the centered layout. */}
      <div
        className={
          HOURS_ENABLED
            ? "space-y-8"
            : "absolute bottom-0 left-0 right-0 space-y-4 pb-12"
        }
      >
        {/* Hours follow-up — only when the participant does this task and the
          hours feature is on */}
        {HOURS_ENABLED && primaryAnswer === "yes" && (
          <div className="space-y-5 animate-fadeSlideIn">
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

        {/* Continue — only needed when hours follow-up is active */}
        {HOURS_ENABLED && primaryAnswer !== null && (
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
  extraTasks,
  extraInput,
  onExtraInputChange,
  onAddExtra,
  onRemoveExtra,
  onRemoveConfirmed,
  addEarnedUsd,
  addCapped,
  onSubmit,
}: {
  confirmedTasks: TaskItem[];
  extraTasks: { name: string; addedAt: number }[];
  extraInput: string;
  onExtraInputChange: (v: string) => void;
  onAddExtra: (v: string) => void;
  onRemoveExtra: (idx: number) => void;
  onRemoveConfirmed: (idx: number) => void;
  addEarnedUsd: number;
  addCapped: boolean;
  onSubmit: (pendingExtra?: string) => void;
}) {
  const totalDisplayedSoFar = confirmedTasks.length;
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
    // my-auto centers vertically; the extra bottom padding on the scroll
    // container (see isExhausted branch) biases it slightly above center.
    <div className="w-full my-auto animate-fadeSlideIn">
      {totalDisplayedSoFar > 0 && (
        <section>
          <h3 className="text-[1.35rem] font-light text-slate-800 leading-snug tracking-tight">
            Here are your tasks so far
          </h3>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-0.5 mt-1.5">
            <p className="text-sm text-slate-500">
              We found {totalDisplayedSoFar} task
              {totalDisplayedSoFar !== 1 ? "s" : ""} from this interaction.
            </p>
            <p className="text-xs text-slate-400">
              Use the × to remove a task.
            </p>
          </div>

          <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {confirmedTasks.map((t, i) => (
              <div
                key={`${t.name}-${i}`}
                className="group relative px-4 py-3 rounded-xl bg-white border border-slate-200 hover:border-indigo-200 hover:shadow-sm transition"
              >
                <p className="text-sm text-slate-800 leading-snug pr-6">
                  {t.name}
                </p>
                {t.status === "edited" && (
                  <span className="mt-1.5 inline-block text-[10px] font-semibold uppercase tracking-wider text-amber-600">
                    edited
                  </span>
                )}
                <button
                  onClick={() => onRemoveConfirmed(i)}
                  aria-label="Remove task"
                  className="absolute top-2 right-2 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity w-7 h-7 sm:w-5 sm:h-5 flex items-center justify-center rounded-full text-slate-400 sm:text-slate-300 hover:text-red-400 hover:bg-red-50"
                >
                  <svg
                    viewBox="0 0 16 16"
                    className="w-3 h-3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  >
                    <line x1="4" y1="4" x2="12" y2="12" />
                    <line x1="12" y1="4" x2="4" y2="12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* What else fills your week. */}
      <section className="mt-16">
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
