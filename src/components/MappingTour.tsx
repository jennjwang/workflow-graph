import { useMemo, useEffect, ReactNode } from 'react';
import { useReactFlow, useViewport, Node } from '@xyflow/react';
import { useShallow } from 'zustand/react/shallow';
import { useWorkflowStore } from '../store';
import { WorkflowNodeData } from '../types';

type WFNode = Node<WorkflowNodeData>;

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-0.5 px-1.5 py-px rounded-full border border-blue-200 bg-blue-50/80 text-blue-600 font-medium align-baseline whitespace-nowrap">
      {children}
    </span>
  );
}

type Step = {
  title: string;
  pickTargetId: (nodes: WFNode[]) => string | null;
  body: ReactNode;
  // When true, the tour forces the target node's hover-revealed "+" affordance
  // visible so participants can see what the instruction refers to.
  spotlightAddButton?: boolean;
};

const STEPS: Step[] = [
  {
    title: 'Your task',
    pickTargetId: nodes => nodes.find(n => !n.data.parentId)?.id ?? null,
    body: (
      <p>
        This card is the task you're mapping. The dashed subtasks below were proposed by AI — tap <Chip>✦ subtasks</Chip> on any task to get more.
      </p>
    ),
  },
  {
    title: 'Keep or discard',
    pickTargetId: nodes =>
      nodes.find(n => n.data.parentId && n.data.confirmed === false)?.id ?? null,
    body: (
      <p>
        Dashed cards are drafts. <span className="font-medium text-slate-800">Click</span> one to keep it; <span className="font-medium text-slate-800">click again</span> to discard.
      </p>
    ),
  },
  {
    title: 'Rename for a bonus',
    pickTargetId: nodes => nodes.find(n => n.data.parentId)?.id ?? null,
    body: (
      <>
        <p>
          <span className="font-medium text-slate-800">Double-click</span> a task to rename it and make it match how you actually work.
        </p>
        <p className="mt-2 text-amber-700">
          Each character you change earns the <span className="font-semibold">bonus</span> shown in the top bar.
        </p>
      </>
    ),
  },
  {
    title: 'Add your own',
    pickTargetId: nodes => nodes.find(n => n.data.parentId)?.id ?? null,
    spotlightAddButton: true,
    body: (
      <p>
        Missing something? Click the <span className="font-medium text-slate-800">+</span> on a task's right edge to add a subtask manually.
      </p>
    ),
  },
  {
    title: 'Make it representative',
    // No target — this is a meta instruction about when to stop, not about a
    // specific affordance. The tooltip centers itself with a dimmed backdrop.
    pickTargetId: () => null,
    body: (
      <>
        <p>
          Keep refining — confirm, rename, or add subtasks — until the map represents how you actually do this task.
        </p>
        <p className="mt-2 text-slate-500">
          You'll need at least 3 active subtasks before you can move on.
        </p>
      </>
    ),
  },
];

const TOOLTIP_W = 320;
const TOOLTIP_GAP = 18;
const VIEWPORT_PAD = 16;

export function MappingTour() {
  const { tourStep, advanceTour, endTour, nodes, setTourSpotlightAddNode } = useWorkflowStore(useShallow(s => ({
    tourStep: s.tourStep,
    advanceTour: s.advanceTour,
    endTour: s.endTour,
    nodes: s.nodes,
    setTourSpotlightAddNode: s.setTourSpotlightAddNode,
  })));
  const rf = useReactFlow();
  const viewport = useViewport();

  const active = tourStep >= 0 && tourStep < STEPS.length;

  const target = useMemo(() => {
    if (!active) return null;
    const step = STEPS[tourStep];
    const id = step.pickTargetId(nodes);
    if (!id) return null;
    const rfNode = rf.getNode(id);
    if (!rfNode?.position) return null;
    const w = rfNode.measured?.width ?? rfNode.width ?? 220;
    const h = rfNode.measured?.height ?? rfNode.height ?? 80;
    const tl = rf.flowToScreenPosition({ x: rfNode.position.x, y: rfNode.position.y });
    return { nodeId: id, x: tl.x, y: tl.y, w: w * viewport.zoom, h: h * viewport.zoom };
  }, [active, tourStep, nodes, rf, viewport]);

  // Tell the matching node to reveal its hover-only "+" while this step is up.
  useEffect(() => {
    if (active && target && STEPS[tourStep].spotlightAddButton) {
      setTourSpotlightAddNode(target.nodeId);
    } else {
      setTourSpotlightAddNode(null);
    }
    return () => setTourSpotlightAddNode(null);
  }, [active, tourStep, target?.nodeId, setTourSpotlightAddNode]);

  if (!active) return null;

  const step = STEPS[tourStep];
  const isLast = tourStep === STEPS.length - 1;

  // Tooltip position — prefer right of target, fall back to left, then centered.
  let tooltipStyle: React.CSSProperties;
  if (target) {
    const placeRight = target.x + target.w + TOOLTIP_GAP + TOOLTIP_W < window.innerWidth - VIEWPORT_PAD;
    const x = placeRight
      ? target.x + target.w + TOOLTIP_GAP
      : Math.max(VIEWPORT_PAD, target.x - TOOLTIP_GAP - TOOLTIP_W);
    const rawY = target.y + target.h / 2;
    const y = Math.min(
      window.innerHeight - VIEWPORT_PAD,
      Math.max(VIEWPORT_PAD + 80, rawY),
    );
    tooltipStyle = { left: x, top: y, width: TOOLTIP_W, transform: 'translateY(-50%)' };
  } else {
    tooltipStyle = {
      left: '50%',
      top: '50%',
      width: TOOLTIP_W,
      transform: 'translate(-50%, -50%)',
    };
  }

  return (
    <>
      {/* Backdrop + ring around the target (pointer-events-none so the canvas
          stays interactive — the tour is a guide, not a modal). */}
      {target && (
        <div className="fixed inset-0 z-40 pointer-events-none">
          <div
            className="absolute rounded-2xl ring-2 ring-indigo-400 transition-all duration-300"
            style={{
              left: target.x - 4,
              top: target.y - 4,
              width: target.w + 8,
              height: target.h + 8,
              boxShadow: '0 0 0 9999px rgba(15, 23, 42, 0.5)',
            }}
          />
        </div>
      )}
      {/* When no target is available yet, dim the whole viewport so the tooltip stands out. */}
      {!target && (
        <div className="fixed inset-0 z-40 bg-slate-900/40 pointer-events-none" />
      )}
      <div
        className="fixed z-50 bg-white rounded-2xl border border-slate-200 shadow-xl p-5"
        style={tooltipStyle}
      >
        <div className="flex items-center justify-between mb-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-indigo-400">
            {tourStep + 1} of {STEPS.length} · {step.title}
          </p>
          <button
            onClick={endTour}
            className="text-[11px] text-slate-400 hover:text-slate-600 transition"
          >
            Skip tour
          </button>
        </div>
        <div className="text-[13px] text-slate-600 leading-relaxed space-y-1">{step.body}</div>
        <div className="flex justify-end mt-4">
          <button
            onClick={isLast ? endTour : advanceTour}
            className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition"
          >
            {isLast ? 'Got it' : 'Next →'}
          </button>
        </div>
      </div>
    </>
  );
}
