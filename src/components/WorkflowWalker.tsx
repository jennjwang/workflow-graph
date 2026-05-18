import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Node, Edge } from "@xyflow/react";
import { useWorkflowStore } from "../store";
import {
  sendChatMessage,
  fetchInterview,
  InterviewStep,
  saveSession,
  proposeSubtasks,
} from "../lib/api";
import type { GraphUpdate, WorkflowNodeData, NodeType } from "../types";

const NODE_WIDTH = 220;
const NODE_HEIGHT = 100;
const CARD_OFFSET_X = 320; // distance to the right of the anchor's right edge
const CARD_OFFSET_Y = -40; // slight upward bias so the card sits at anchor's top-right

type WalkerStatus =
  | "idle"
  | "extracting"
  | "analyzing"
  | "walking"
  | "no-gaps"
  | "done"
  | "error";

type Kind = "transition" | "missing" | "decompose";

const KIND_LABEL: Record<Kind, string> = {
  transition: "Workflow steps",
  missing: "Missing tasks",
  decompose: "Tasks broken down",
};

const KIND_ORDER: Kind[] = ["transition", "missing", "decompose"];

type Suggestion = { label: string; description?: string; type?: NodeType };

const KICKOFF_HINT = (task: string) =>
  `Ask the participant exactly: "Can you walk me through how you ${task} from start to finish?"`;

interface OverlayCallbacks {
  onYes: () => void;
  onNo: () => void;
  onAdd: (picked: Suggestion[]) => void;
  onSkip: () => void;
}

// Build the overlay (markers + card) for the current interview step.
function buildOverlay(
  step: InterviewStep | null,
  realNodes: Node<WorkflowNodeData>[],
  realEdges: Edge[],
  cb: OverlayCallbacks,
): { nodes: Node<WorkflowNodeData>[]; edges: Edge[] } {
  if (!step) return { nodes: [], edges: [] };
  const anchor = realNodes.find((n) => n.id === step.anchor_node_id);
  if (!anchor) return { nodes: [], edges: [] };

  const overlayNodes: Node<WorkflowNodeData>[] = [];
  const overlayEdges: Edge[] = [];

  // Mark what's being modified so the user can connect the card to the graph at a glance.
  // - decompose: halo around the task being broken down
  // - transition: small dot at the midpoint of prev → anchor edge (the transition being asked about)
  let connectorSourceId = anchor.id; // where the card's connector line pulls FROM
  const DOT_SIZE = 14;

  if (step.kind === "decompose") {
    const HALO_PAD = 10;
    overlayNodes.push({
      id: `__highlight__${anchor.id}`,
      type: "walkerHighlight",
      position: {
        x: anchor.position.x - HALO_PAD,
        y: anchor.position.y - HALO_PAD,
      },
      data: { label: "", description: "", nodeType: "task" },
      style: {
        width: NODE_WIDTH + HALO_PAD * 2,
        height: NODE_HEIGHT + HALO_PAD * 2,
      },
      draggable: false,
      selectable: false,
      zIndex: 1,
    });
  } else if (step.kind === "transition" || step.kind === "missing") {
    // Drop a small violet dot at the midpoint of prev → anchor edge.
    // Transition: marks the existing edge being asked about.
    // Missing: marks where the proposed new task would slot in.
    const incoming = realEdges.find((e) => e.target === anchor.id);
    const pred = incoming
      ? realNodes.find((n) => n.id === incoming.source)
      : null;
    if (pred) {
      const dotId = `__${step.kind}dot__${anchor.id}`;
      const midX = (pred.position.x + anchor.position.x) / 2 + NODE_WIDTH / 2 - DOT_SIZE / 2;
      const midY = (pred.position.y + anchor.position.y) / 2 + NODE_HEIGHT / 2 - DOT_SIZE / 2;
      overlayNodes.push({
        id: dotId,
        type: "walkerInsertionDot",
        position: { x: midX, y: midY },
        data: { label: "", description: "", nodeType: "task" },
        style: { width: DOT_SIZE, height: DOT_SIZE },
        draggable: false,
        selectable: false,
        zIndex: 6,
      });
      connectorSourceId = dotId;
    }
  }

  // Card node — positioned to the right of the anchor
  const cardId = `__walkercard__${step.kind}_${step.anchor_node_id}`;
  overlayNodes.push({
    id: cardId,
    type: "walkerCard",
    position: {
      x: anchor.position.x + NODE_WIDTH + CARD_OFFSET_X,
      y: anchor.position.y + CARD_OFFSET_Y,
    },
    data: {
      label: "",
      description: "",
      nodeType: "task",
      cardKind: step.kind,
      cardQuestion: step.question,
      cardEdgeLabel: step.edge_label,
      cardProposedLabel: step.proposed_task?.label,
      cardSuggestions: step.suggestions ?? [],
      onYes: cb.onYes,
      onNo: cb.onNo,
      onAdd: cb.onAdd,
      onSkip: cb.onSkip,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    draggable: false,
    selectable: false,
    zIndex: 10,
  });

  // Connector line from the modified anchor (or the insertion dot, for missing-task gaps)
  // out to the card. Visible so the user can trace the card back to its location.
  overlayEdges.push({
    id: `__connector__${cardId}`,
    source: connectorSourceId,
    target: cardId,
    type: "smoothstep",
    style: { stroke: "#a78bfa", strokeWidth: 2, strokeDasharray: "5,4" },
    animated: true,
    selectable: false,
    zIndex: 4,
  });

  return { nodes: overlayNodes, edges: overlayEdges };
}

export function WorkflowWalker() {
  const {
    sessionId,
    coreTask,
    addMessage,
    setLoading,
    applyGraphUpdates,
    nodes,
    edges,
    userProfile,
    selectedTasks,
    setWalkerOverlay,
    pendingExpand,
    setPendingExpand,
    addSubstepChained,
  } = useWorkflowStore(
    useShallow((s) => ({
      sessionId: s.sessionId,
      coreTask: s.coreTask,
      addMessage: s.addMessage,
      setLoading: s.setLoading,
      applyGraphUpdates: s.applyGraphUpdates,
      nodes: s.nodes,
      edges: s.edges,
      userProfile: s.userProfile,
      selectedTasks: s.selectedTasks,
      setWalkerOverlay: s.setWalkerOverlay,
      pendingExpand: s.pendingExpand,
      setPendingExpand: s.setPendingExpand,
      addSubstepChained: s.addSubstepChained,
    })),
  );

  const [status, setStatus] = useState<WalkerStatus>("extracting");
  const [steps, setSteps] = useState<InterviewStep[]>([]);
  const [stepIdx, setStepIdx] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [expandSubs, setExpandSubs] = useState<Suggestion[]>([]);
  const hasKickedOff = useRef(false);
  const subtaskVariant = new URLSearchParams(window.location.search).get("subtask_variant") ?? undefined;
  const hasFetchedInterview = useRef(false);

  // Kickoff: extract top-level nodes from the participant's first answer.
  useEffect(() => {
    if (hasKickedOff.current) return;
    hasKickedOff.current = true;

    const existing = useWorkflowStore.getState().messages;
    if (existing.length === 0) return;

    setLoading(true);
    setStatus("extracting");
    const taskPhrase = coreTask.charAt(0).toLowerCase() + coreTask.slice(1);
    const allMessages = [
      {
        id: "__kickoff__",
        role: "user" as const,
        content: KICKOFF_HINT(taskPhrase),
        timestamp: 0,
      },
      ...existing,
    ];

    sendChatMessage(
      allMessages,
      coreTask,
      [],
      true,
      userProfile,
      selectedTasks,
      null,
      (u: GraphUpdate) => applyGraphUpdates([u]),
    )
      .then(({ message }) => {
        if (message) addMessage("assistant", message);
        setStatus("analyzing");
      })
      .catch((err) => {
        console.error("[walker] extraction failed:", err);
        addMessage("assistant", `Error: ${err.message}`);
        setErrorMsg(`Extraction failed: ${err.message}`);
        setStatus("error");
      })
      .finally(() => setLoading(false));
  }, []);

  // Generate the interview script once after extraction completes.
  useEffect(() => {
    if (status !== "analyzing" || hasFetchedInterview.current) return;
    if (nodes.length === 0) return;
    hasFetchedInterview.current = true;

    const participantOverview = useWorkflowStore
      .getState()
      .messages.filter((m) => m.role === "user" && m.id !== "__kickoff__")
      .map((m) => m.content)
      .join("\n\n");

    fetchInterview(
      nodes.map((n) => ({
        id: n.id,
        type: n.data.nodeType,
        label: n.data.label,
        description: n.data.description,
      })),
      edges.map((e) => ({
        source: e.source,
        target: e.target,
        label: typeof e.label === "string" ? e.label : undefined,
      })),
      coreTask,
      userProfile.jobTitle,
      participantOverview,
    )
      .then((items) => {
        // Drop steps whose anchor isn't a real non-sentinel node — those would
        // anchor markers/cards to nothing or to the start/end sentinels.
        const filtered = items.filter((s) => {
          const anchor = nodes.find((n) => n.id === s.anchor_node_id);
          if (!anchor) return false;
          if (
            anchor.data.nodeType === "start" ||
            anchor.data.nodeType === "end"
          ) {
            console.info(
              "[walker] dropping step anchored at sentinel:",
              s.question,
              "anchor:",
              s.anchor_node_id,
            );
            return false;
          }
          // Decompose steps must not anchor at decisions.
          if (s.kind === "decompose" && anchor.data.nodeType === "decision") {
            console.info(
              "[walker] dropping decompose step anchored at decision:",
              s.question,
            );
            return false;
          }
          return true;
        });
        console.info(
          "[walker] interview returned",
          items.length,
          "steps;",
          filtered.length,
          "after filter",
        );
        setSteps(filtered);
        setStepIdx(0);
        setStatus(filtered.length > 0 ? "walking" : "no-gaps");
      })
      .catch((err) => {
        console.error("[walker] interview generation failed:", err);
        setErrorMsg(`Interview failed: ${err.message ?? err}`);
        setStatus("error");
      });
  }, [status, nodes.length]);

  const walkerStep = status === "walking" ? (steps[stepIdx] ?? null) : null;

  // Watch for explicit "+ break down" requests and fetch sub-step proposals.
  useEffect(() => {
    if (!pendingExpand) {
      setExpandSubs([]);
      return;
    }
    setExpandSubs([]);
    const existingForExpand = nodes
      .filter(
        (n) =>
          n.id !== pendingExpand.nodeId &&
          n.data.parentId !== pendingExpand.nodeId,
      )
      .map((n) => ({ id: n.id, label: n.data.label, type: n.data.nodeType }));
    proposeSubtasks(
      pendingExpand.nodeLabel,
      coreTask,
      userProfile.jobTitle,
      undefined,
      existingForExpand,
      undefined,
      undefined,
      { promptVariant: subtaskVariant },
    )
      .then(setExpandSubs)
      .catch((err) => console.error("[walker] break-down failed:", err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingExpand?.nodeId]);

  // Synthetic decompose step for the user-driven "+ break down" flow.
  const expandStep: InterviewStep | null = useMemo(() => {
    if (!pendingExpand || expandSubs.length === 0) return null;
    return {
      kind: "decompose",
      anchor_node_id: pendingExpand.nodeId,
      question: `When you "${pendingExpand.nodeLabel}", what specifically do you do?`,
      suggestions: expandSubs,
    };
  }, [pendingExpand, expandSubs]);

  // Break-down takes precedence over the structured walk.
  const currentStep: InterviewStep | null = expandStep ?? walkerStep;
  const isExpand = !!expandStep;

  const advance = () => {
    if (stepIdx + 1 >= steps.length) {
      setStatus("done");
      setWalkerOverlay([], []);
    } else {
      setStepIdx(stepIdx + 1);
    }
  };

  const closeExpandOrAdvance = () => {
    if (isExpand) {
      setPendingExpand(null);
    } else {
      advance();
    }
  };

  const handleYes = () => {
    if (!currentStep) return closeExpandOrAdvance();

    if (currentStep.kind === "transition") {
      // If the model identified an artifact flowing on this edge, label the edge with it.
      const label = currentStep.edge_label;
      if (label && currentStep.prev_node_id) {
        // Re-add the edge with the new label (applyGraphUpdates skips existing ids;
        // mutate the store directly to update the existing edge).
        const existingEdges = useWorkflowStore.getState().edges;
        const existing = existingEdges.find(
          (e) =>
            e.source === currentStep.prev_node_id &&
            e.target === currentStep.anchor_node_id,
        );
        if (existing && existing.label !== label) {
          useWorkflowStore.setState({
            edges: existingEdges.map((e) =>
              e.id === existing.id ? { ...e, label } : e,
            ),
          });
        }
      }
    } else if (currentStep.kind === "missing") {
      // Insert the proposed task between prev and anchor.
      const proposed = currentStep.proposed_task;
      const prev = currentStep.prev_node_id;
      const target = currentStep.anchor_node_id;
      if (proposed && prev && target) {
        applyGraphUpdates([
          {
            tool: "add_node",
            input: {
              id: proposed.id,
              type: proposed.type,
              label: proposed.label,
              description: proposed.description,
            },
          },
          { tool: "add_edge", input: { source: prev, target: proposed.id } },
          { tool: "add_edge", input: { source: proposed.id, target } },
          { tool: "remove_edge", input: { source: prev, target } },
        ]);
        saveSession(
          sessionId,
          coreTask,
          {
            nodes: useWorkflowStore.getState().nodes,
            edges: useWorkflowStore.getState().edges,
          },
          useWorkflowStore.getState().messages,
        ).catch(() => {});
      }
    }
    closeExpandOrAdvance();
  };

  const handleNo = () => {
    // Reject — for v1 just advance. Future: allow editing the next task.
    closeExpandOrAdvance();
  };

  const handleAdd = (picked: Suggestion[]) => {
    // Decompose accepted — chain each picked sub-step under the anchor.
    const anchorId = currentStep?.anchor_node_id;
    if (anchorId) {
      for (const sub of picked) addSubstepChained(anchorId, sub);
      saveSession(
        sessionId,
        coreTask,
        {
          nodes: useWorkflowStore.getState().nodes,
          edges: useWorkflowStore.getState().edges,
        },
        useWorkflowStore.getState().messages,
      ).catch(() => {});
    }
    closeExpandOrAdvance();
  };

  const handleSkip = () => {
    closeExpandOrAdvance();
  };

  // Push the overlay (markers + card) into the store for the canvas to render.
  useEffect(() => {
    const overlay = buildOverlay(currentStep, nodes, edges, {
      onYes: handleYes,
      onNo: handleNo,
      onAdd: handleAdd,
      onSkip: handleSkip,
    });
    setWalkerOverlay(overlay.nodes, overlay.edges);
    return () => setWalkerOverlay([], []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep?.kind, currentStep?.anchor_node_id, nodes.length, edges.length]);

  // Per-kind counts shown in the status card.
  const kindCounts = useMemo(() => {
    const acc: Record<Kind, { done: number; total: number }> = {
      transition: { done: 0, total: 0 },
      missing: { done: 0, total: 0 },
      decompose: { done: 0, total: 0 },
    };
    const processedThrough = status === "done" ? steps.length : stepIdx;
    steps.forEach((s, i) => {
      const k = s.kind in acc ? (s.kind as Kind) : "transition";
      acc[k].total += 1;
      if (i < processedThrough) acc[k].done += 1;
    });
    return acc;
  }, [steps, stepIdx, status]);

  return (
    <StatusCard
      status={status}
      coreTask={coreTask}
      currentIdx={stepIdx}
      total={steps.length}
      kindCounts={kindCounts}
      errorMsg={errorMsg}
      nodeCount={nodes.length}
    />
  );
}

function StatusCard({
  status,
  coreTask,
  currentIdx,
  total,
  kindCounts,
  errorMsg,
  nodeCount,
}: {
  status: WalkerStatus;
  coreTask: string;
  currentIdx: number;
  total: number;
  kindCounts: Record<Kind, { done: number; total: number }>;
  errorMsg: string | null;
  nodeCount: number;
}) {
  const showSpinner = status === "extracting" || status === "analyzing";
  const headerLabel =
    status === "extracting"
      ? "Extracting tasks"
      : status === "analyzing"
        ? "Building interview"
        : status === "walking"
          ? "Walking the workflow"
          : status === "no-gaps"
            ? "Workflow looks complete"
            : status === "error"
              ? "Something went wrong"
              : "Done";
  const stepNum =
    status === "walking" ? currentIdx + 1 : status === "done" ? total : 0;
  const stepTotal = total;

  return (
    <div className="absolute top-6 left-6 z-30 w-[340px] bg-white/95 backdrop-blur rounded-2xl border border-slate-200 shadow-lg px-5 py-4 pointer-events-auto">
      <div className="flex items-center gap-2">
        {showSpinner && (
          <span className="inline-block w-3.5 h-3.5 border-2 border-violet-300 border-t-violet-600 rounded-full animate-spin" />
        )}
        {!showSpinner && (status === "done" || status === "no-gaps") && (
          <span className="text-emerald-600 text-sm">✓</span>
        )}
        {status === "error" && <span className="text-red-500 text-sm">⚠</span>}
        <p className="text-sm font-semibold text-slate-700">{headerLabel}</p>
      </div>
      <p className="text-xs text-slate-400 mt-0.5 truncate">{coreTask}</p>

      {(status === "walking" || status === "done") && stepTotal > 0 && (
        <>
          <p className="text-xs text-slate-500 mt-3">
            Step <span className="font-semibold text-slate-700">{stepNum}</span>{" "}
            of <span className="text-slate-500">{stepTotal}</span>
          </p>
          <div className="flex gap-1 mt-1.5">
            {Array.from({ length: stepTotal }).map((_, i) => (
              <div
                key={i}
                className={`flex-1 h-1.5 rounded-full ${i < currentIdx ? "bg-emerald-400" : i === currentIdx && status === "walking" ? "bg-violet-500" : "bg-slate-200"}`}
              />
            ))}
          </div>
        </>
      )}

      {(status === "walking" || status === "done") && stepTotal > 0 && (
        <div className="mt-4 space-y-0">
          {KIND_ORDER.map((kind, i) => {
            const c = kindCounts[kind];
            if (c.total === 0) return null;
            const dotColor =
              kind === "transition" ? "bg-violet-500" : kind === "missing" ? "bg-fuchsia-500" : "bg-blue-400";
            return (
              <div
                key={kind}
                className={`flex items-center justify-between py-2.5 ${i > 0 ? "border-t border-slate-100" : ""}`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`w-2 h-2 rounded-full ${c.done >= c.total ? "bg-emerald-400" : dotColor}`}
                  />
                  <span className="text-sm text-slate-600">
                    {KIND_LABEL[kind]}
                  </span>
                </div>
                <span className="text-sm font-semibold text-slate-700">
                  {c.done}/{c.total}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {status === "done" && (
        <p className="text-xs text-slate-400 mt-3 italic">
          Workflow review complete.
        </p>
      )}
      {status === "no-gaps" && (
        <p className="text-xs text-slate-500 mt-3 leading-snug">
          Reviewed {nodeCount} step{nodeCount !== 1 ? "s" : ""} — You can keep
          editing the graph manually.
        </p>
      )}
      {status === "error" && errorMsg && (
        <p className="text-xs text-red-600 mt-3 leading-snug">{errorMsg}</p>
      )}
    </div>
  );
}
