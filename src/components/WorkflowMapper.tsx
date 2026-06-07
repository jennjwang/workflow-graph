import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useWorkflowStore, MAP_LIMIT } from "../store";
import { proposeSubtasks } from "../lib/api";
import { BONUS_ENABLED, formatUsd, mappingEditBonusUsd } from "../lib/bonus";

export function WorkflowMapper() {
  const {
    coreTask,
    coreTaskShort,
    setLoading,
    userProfile,
    selectedTasks,
    currentTaskIdx,
    advanceToNextTask,
    nodes,
    seedRoot,
    addChildNodes,
    pendingExpand,
    setPendingExpand,
    startTour,
    mappingEditChars,
    mappingAddedNodes,
    tourStep,
  } = useWorkflowStore(
    useShallow((s) => ({
      coreTask: s.coreTask,
      coreTaskShort: s.coreTaskShort,
      setLoading: s.setLoading,
      userProfile: s.userProfile,
      selectedTasks: s.selectedTasks,
      currentTaskIdx: s.currentTaskIdx,
      advanceToNextTask: s.advanceToNextTask,
      nodes: s.nodes,
      seedRoot: s.seedRoot,
      addChildNodes: s.addChildNodes,
      pendingExpand: s.pendingExpand,
      setPendingExpand: s.setPendingExpand,
      startTour: s.startTour,
      mappingEditChars: s.mappingEditChars,
      mappingAddedNodes: s.mappingAddedNodes,
      tourStep: s.tourStep,
    })),
  );

  const displayLabel = coreTaskShort || coreTask;

  const tourActive = tourStep >= 0;

  const bonus = mappingEditBonusUsd(mappingEditChars, mappingAddedNodes);

  const [extracting, setExtracting] = useState(true);
  // Panel starts collapsed (small pill) so it doesn't cover the root node. The
  // tour has already introduced the affordances; the panel is a passive
  // reference participants can pop open when they want it.
  const [howToCollapsed, setHowToCollapsed] = useState(true);
  const [subtaskToast, setSubtaskToast] = useState<string | null>(null);
  const hasKickedOff = useRef(false);
  const subtaskVariant = new URLSearchParams(window.location.search).get("subtask_variant") ?? undefined;
  // Tracks whether the coach-mark tour has run at least once on this mount.
  // Used to suppress the "How to map" panel during the gap between extracting
  // completing and the tour actually starting (a ~400ms window where both
  // !extracting and !tourActive would otherwise be true, causing the panel to
  // flash before the tour takes over).
  const tourHasStarted = useRef(false);
  useEffect(() => {
    if (tourActive) tourHasStarted.current = true;
  }, [tourActive]);

  useEffect(() => {
    if (!subtaskToast) return;
    const t = setTimeout(() => setSubtaskToast(null), 4500);
    return () => clearTimeout(t);
  }, [subtaskToast]);

  // Auto-decompose: clicking "+ break down" on a node sets pendingExpand. We
  // immediately fetch sub-task proposals and add them as children, no modal.
  useEffect(() => {
    if (!pendingExpand) return;
    const nodeId = pendingExpand.nodeId;
    const label = pendingExpand.nodeLabel;
    const snapshot = useWorkflowStore.getState().nodes;
    // Split the snapshot into (direct children of the node being expanded) and
    // (everything else in the tree). The server switches to "more" mode when
    // existingChildren is non-empty and asks for complementary sub-tasks.
    const existingChildren = snapshot
      .filter((n) => n.data.parentId === nodeId)
      .map((n) => ({ id: n.id, label: n.data.label }));
    const existingNodes = snapshot
      .filter((n) => n.id !== nodeId && n.data.parentId !== nodeId)
      .map((n) => ({ id: n.id, label: n.data.label, type: n.data.nodeType }));
    // Build the ancestor chain (root → ... → parent) so the server can match
    // sub-task granularity to depth.
    const ancestorChain: string[] = [];
    let cursor = snapshot.find((n) => n.id === nodeId);
    while (cursor?.data.parentId) {
      const parent = snapshot.find((n) => n.id === cursor!.data.parentId);
      if (!parent) break;
      ancestorChain.unshift(parent.data.label);
      cursor = parent;
    }
    // Walkthrough grounds the AI on the participant's actual described work so
    // it doesn't pad with generic workplace clichés ("daily standup", etc.).
    // Pass it on every expansion, not just the root kickoff.
    const msgs = useWorkflowStore.getState().messages;
    const lastUser = [...msgs].reverse().find((m) => m.role === "user");
    const walkthrough = lastUser?.content;
    // Sub-tasks the participant previously discarded for this parent — teach
    // the AI not to re-propose what they already rejected.
    const rejected = useWorkflowStore.getState().rejectedByParent[nodeId] ?? [];
    proposeSubtasks(
      label,
      coreTask,
      userProfile.jobTitle,
      walkthrough,
      existingNodes,
      existingChildren,
      ancestorChain,
      {
        responsibilities: userProfile.responsibilities,
        typicalWeek: userProfile.typicalWeek,
        rejected,
        promptVariant: subtaskVariant,
      },
    )
      .then((subs) => {
        const newOnly = subs
          .filter((s) => !s.linkToExistingId)
          .map((s) => ({
            label: s.label,
            description: '',
            confirmed: false,
          }))
          // Hard cap: keep the canvas legible by adding at most 4 fresh subtasks
          // per expansion — the participant can click "✦ more subtasks" again
          // for another batch if needed.
          .slice(0, 4);
        if (newOnly.length === 0) {
          console.warn("[mapper] proposeSubtasks returned no new sub-tasks", {
            nodeId,
            label,
            subs,
          });
          setSubtaskToast(
            subs.length > 0
              ? "All AI suggestions matched tasks already on the canvas — nothing new to add."
              : "No more subtasks to suggest for this task. Try renaming it or adding one with the + button.",
          );
        } else {
          addChildNodes(nodeId, newOnly);
        }
      })
      .catch((err) => {
        console.error("[mapper] proposeSubtasks failed:", err);
        setSubtaskToast("Couldn't load AI suggestions. Please try again.");
      })
      .finally(() => setPendingExpand(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingExpand?.nodeId]);

  // Kickoff: seed the root from coreTask, then auto-decompose using the
  // participant's walkthrough as context for the first set of sub-tasks.
  useEffect(() => {
    // Store-level claim survives React StrictMode's double-mount; a useRef guard
    // would reset on remount and let the AI call fire twice (→ duplicate children).
    const idx = useWorkflowStore.getState().currentTaskIdx;
    if (!useWorkflowStore.getState().markKickoffStarted(idx)) return;
    hasKickedOff.current = true;

    const msgs = useWorkflowStore.getState().messages;
    const lastUser = [...msgs].reverse().find((m) => m.role === "user");
    const walkthrough = lastUser?.content;

    setLoading(true);
    // Defer seedRoot until the first layer is ready — keeps the canvas empty
    // (loader-only) until the AI responds, then reveals root + children in one go.
    // Root has no ancestors; pass [] so the server treats this as depth-0.
    proposeSubtasks(
      coreTask,
      coreTask,
      userProfile.jobTitle,
      walkthrough,
      undefined,
      undefined,
      [],
      {
        responsibilities: userProfile.responsibilities,
        typicalWeek: userProfile.typicalWeek,
        rejected: [],
        promptVariant: subtaskVariant,
      },
    )
      .then((subs) => {
        const newOnly = subs
          .filter((s) => !s.linkToExistingId)
          .map((s) => ({
            label: s.label,
            description: '',
            confirmed: false,
          }))
          // Match the per-expansion cap so the very first layer also stays
          // legible; the participant can ask for more via "✦ more subtasks".
          .slice(0, 4);
        const rootId = seedRoot();
        if (newOnly.length > 0) addChildNodes(rootId, newOnly);
      })
      .catch(() => {
        // Even on failure, give the user a root to work from manually.
        seedRoot();
      })
      .finally(() => {
        setLoading(false);
        setExtracting(false);
        // First task only: launch the coach-mark tour once nodes are on screen.
        // Give React Flow a moment to lay out + measure before the tour reads
        // node geometry to position its highlight.
        if (useWorkflowStore.getState().currentTaskIdx === 0) {
          setTimeout(() => startTour(), 400);
        }
      });
    // Intentionally empty deps — kickoff runs once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mapping-phase persistence is handled by the top-level auto-save in App.tsx,
  // which watches every store slice getExportData serializes and debounces a
  // /api/session write. No per-phase save effect needed here.

  // mapCount mirrors store.advanceToNextTask: the participant may have picked
  // more essentials than MAP_LIMIT, but the mapping loop stops after MAP_LIMIT.
  const mapCount = Math.min(selectedTasks.length, MAP_LIMIT);
  const isLastTask = currentTaskIdx + 1 >= mapCount;
  const nextLabel = isLastTask ? "Finish mapping" : "Next task →";

  // Require at least 3 active (confirmed) non-root nodes before advancing —
  // ensures the participant produced a meaningful map rather than skipping past
  // the AI drafts. Both AI-suggested-then-kept and manually-added subtasks count
  // (both have confirmed=true). Drafts still dashed (confirmed=false) do not.
  const REQUIRED_ACTIVE_NODES = 3;
  const activeNonRootNodes = nodes.filter(
    (n) => n.data.parentId && n.data.confirmed !== false,
  ).length;
  const canAdvance = activeNonRootNodes >= REQUIRED_ACTIVE_NODES;

  return (
    <>
      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 z-30 px-5 py-3 flex items-center justify-between bg-white/85 backdrop-blur-sm border-b border-slate-100 pointer-events-none">
        <div className="min-w-0 pointer-events-auto">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-indigo-400">
            Task {currentTaskIdx + 1} of {mapCount}
          </p>
          <p
            className="text-sm font-semibold text-slate-700 truncate"
            title={coreTask}
          >
            {displayLabel}
          </p>
        </div>

        <div className="flex items-center gap-2 pointer-events-auto">
          {/* Live bonus counter — per-character Levenshtein edits against
              AI-suggested originals, plus a flat per-node bonus for manually
              added subtasks. Accumulates across all mapping tasks. */}
          {BONUS_ENABLED && (
            <div
              title={`${formatUsd(bonus.editUsd)} from renaming + ${formatUsd(bonus.addUsd)} from adding subtasks. Cap: ${formatUsd(bonus.maxUsd)}.`}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-medium transition-colors ${
                bonus.capped
                  ? "border-amber-300 bg-amber-100 text-amber-800"
                  : "border-amber-200 bg-amber-50 text-amber-700"
              }`}
            >
              <span className="text-[9px] uppercase tracking-[0.14em] font-semibold opacity-70">
                Bonus
              </span>
              <span className="tabular-nums">{formatUsd(bonus.usd)}</span>
            </div>
          )}
          {!extracting && nodes.length > 0 && (
            <button
              onClick={advanceToNextTask}
              disabled={!canAdvance}
              title={
                canAdvance
                  ? undefined
                  : `Keep at least ${REQUIRED_ACTIVE_NODES} subtasks before moving on (${activeNonRootNodes}/${REQUIRED_ACTIVE_NODES})`
              }
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition ${
                canAdvance
                  ? "bg-slate-800 hover:bg-slate-900 text-white"
                  : "bg-slate-200 text-slate-400 cursor-not-allowed"
              }`}
            >
              {nextLabel}
            </button>
          )}
        </div>
      </div>

      {/* Subtask-suggestion toast — explains 0-result and error cases so the
          participant can tell "out of suggestions" from "something broke." */}
      <div
        className={`absolute top-20 right-5 z-50 transition-all duration-300 ${subtaskToast ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-2 pointer-events-none"}`}
        role="status"
        aria-live="polite"
      >
        <div className="max-w-xs px-4 py-2.5 bg-slate-800 text-white text-[11px] font-medium leading-relaxed rounded-xl shadow-lg">
          {subtaskToast}
        </div>
      </div>

      {/* Empty-state hint while kickoff hasn't produced nodes yet */}
      {extracting && nodes.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="bg-white/90 rounded-xl px-4 py-3 border border-slate-100 shadow-sm flex items-center gap-3">
            <span className="flex gap-1.5">
              {[0, 150, 300].map((d) => (
                <span
                  key={d}
                  className="w-2 h-2 bg-indigo-200 rounded-full animate-bounce"
                  style={{ animationDelay: `${d}ms` }}
                />
              ))}
            </span>
            <p className="text-sm text-slate-500">Mapping your tasks…</p>
          </div>
        </div>
      )}

      {/* Instructions — side panel tucked under the top bar. Hidden while the
          tour runs so it doesn't compete with the tour callouts; reappears
          expanded once the tour finishes (howToCollapsed defaults to false).
          Collapsible to a small pill thereafter when the participant wants the
          canvas clear. On task 0, we additionally wait for the tour to have
          run at least once (tourHasStarted) so the panel doesn't flash in the
          ~400ms gap between extraction completing and the tour kicking off.
          Later tasks have no tour, so currentTaskIdx > 0 lets the panel render
          immediately. */}
      {!extracting &&
        !tourActive &&
        nodes.length > 0 &&
        (currentTaskIdx > 0 || tourHasStarted.current) && (
          <div className="absolute top-20 left-5 pointer-events-none z-[45]">
            {howToCollapsed ? (
              <button
                onClick={() => setHowToCollapsed(false)}
                className="pointer-events-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/95 backdrop-blur-sm border border-slate-200 shadow-sm hover:border-indigo-200 hover:text-indigo-600 text-[11px] font-medium text-slate-600 transition"
                title="Show instructions"
              >
                <span className="text-[9px] uppercase tracking-[0.14em]">
                  How to map
                </span>
                <span className="text-slate-400">▾</span>
              </button>
            ) : (
              <div className="w-64 bg-white/95 backdrop-blur-sm rounded-xl border border-slate-100 shadow-sm pointer-events-auto">
                <div className="px-5 py-4 border-b border-slate-100 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-indigo-400">
                      How to map
                    </p>
                    <p className="text-[11px] text-slate-500 mt-2 leading-relaxed">
                      Break tasks down until splitting reveals nothing new.
                    </p>
                  </div>
                  <button
                    onClick={() => setHowToCollapsed(true)}
                    className="shrink-0 -mt-1 -mr-1 w-6 h-6 rounded-full text-slate-300 hover:bg-slate-100 hover:text-slate-500 grid place-items-center transition"
                    title="Hide instructions"
                    aria-label="Hide instructions"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      className="w-3 h-3"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                    >
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </div>
                <ul className="px-5 py-4 space-y-3 text-[11px] text-slate-600 leading-relaxed">
                  <li className="flex gap-2">
                    <span className="inline-flex items-center gap-0.5 px-1.5 py-px rounded-full border border-blue-200 bg-blue-50/60 text-blue-600 font-medium shrink-0 self-start">
                      ✦ subtasks
                    </span>
                    <span>AI suggests subtasks</span>
                  </li>
                  <li>
                    <span className="font-medium text-slate-700">Click</span> a
                    dashed task — keep / discard
                  </li>
                  <li>
                    <span className="font-medium text-slate-700">
                      Double-click
                    </span>{" "}
                    — rename a task.{" "}
                    <span className="text-amber-700">
                      Earns the bonus per character changed.
                    </span>
                  </li>
                  <li>
                    <span className="font-medium text-slate-700">+ button</span>{" "}
                    on a task's right edge — add a subtask manually
                  </li>
                  <li>
                    <span className="font-medium text-slate-700">
                      Drag and drop
                    </span>{" "}
                    a task onto another to reorganize the relationships
                  </li>
                </ul>
              </div>
            )}
          </div>
        )}
    </>
  );
}
