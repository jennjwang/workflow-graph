import { useEffect, useState, useMemo } from 'react';
import { Handle, Position, NodeProps, Node } from '@xyflow/react';
import { WorkflowNodeData, NodeType } from '../types';
import { useWorkflowStore } from '../store';

// Subtask backdrop — a soft-bg container drawn behind the stacked sub-step cards.
function SubtaskBackdrop() {
  return (
    <div
      className="w-full h-full rounded-2xl bg-slate-100/70 border border-slate-200/80"
      style={{ pointerEvents: 'none' }}
    >
      <div className="px-3 pt-2 pointer-events-none select-none">
        <span className="text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-400">
          sub-steps
        </span>
      </div>
    </div>
  );
}

type WorkflowFlowNode = Node<WorkflowNodeData, NodeType>;

const NODE_WIDTH = 220;

const TYPE_STYLES: Record<NodeType, { border: string; badge: string; bg: string; label: string }> = {
  start:    { border: 'border-slate-400',    badge: 'bg-slate-100 text-slate-600',    bg: 'bg-white',     label: 'start' },
  task:     { border: 'border-blue-300',     badge: 'bg-blue-100 text-blue-700',      bg: 'bg-blue-50',   label: 'task' },
  decision: { border: 'border-amber-400',    badge: 'bg-amber-100 text-amber-700',    bg: 'bg-amber-50',  label: 'decision' },
  handoff:  { border: 'border-violet-400',   badge: 'bg-violet-100 text-violet-700',  bg: 'bg-violet-50', label: 'handoff' },
  input:    { border: 'border-teal-400',     badge: 'bg-teal-100 text-teal-700',      bg: 'bg-teal-50',   label: 'input' },
  failure:  { border: 'border-red-400',      badge: 'bg-red-100 text-red-700',        bg: 'bg-red-50',    label: 'failure' },
  wait:     { border: 'border-amber-400',    badge: 'bg-amber-100 text-amber-700',    bg: 'bg-amber-50',  label: 'wait' },
  end:      { border: 'border-slate-500',    badge: 'bg-slate-100 text-slate-700',    bg: 'bg-slate-50',  label: 'end' },
};

const EXPANDABLE: NodeType[] = ['task', 'handoff', 'wait'];

const PLUS_SVG = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath stroke='%2360a5fa' stroke-width='2' stroke-linecap='round' d='M6 2v8M2 6h8'/%3E%3C/svg%3E")`;

function CircleNode({ id, data, selected }: NodeProps<WorkflowFlowNode>) {
  const isStart = data.nodeType === 'start';
  const currentExploreNodeId = useWorkflowStore(s => s.currentExploreNodeId);
  const isExploring = currentExploreNodeId === id;

  return (
    <div className="flex flex-col items-center group" style={{ width: NODE_WIDTH }}>
      <Handle type="target" position={Position.Top} style={{ width: 8, height: 8, backgroundColor: '#94a3b8', border: '2px solid white', top: -4 }} />
      <div
        className={`w-14 h-14 rounded-full flex items-center justify-center transition-all
          ${isStart
            ? 'border-2 border-slate-500 bg-white'
            : 'bg-slate-700 border-2 border-slate-700'}
          ${isExploring ? 'ring-2 ring-indigo-400 ring-offset-2' : selected ? 'ring-2 ring-blue-400 ring-offset-1' : ''}
        `}
      >
        {isStart && <div className="w-3 h-3 rounded-full bg-slate-500" />}
      </div>
      <p className="text-sm text-slate-700 mt-2 text-center font-medium">{data.label}</p>
      {data.description && <p className="text-xs text-slate-400 mt-0.5 text-center max-w-[180px] line-clamp-2">{data.description}</p>}
      <Handle type="source" position={Position.Bottom} style={{ width: 8, height: 8, backgroundColor: '#94a3b8', border: '2px solid white', bottom: -4 }} />
    </div>
  );
}

export function WorkflowNode({ id, data, selected }: NodeProps<WorkflowFlowNode>) {
  const updateNodeLabel       = useWorkflowStore(s => s.updateNodeLabel);
  const editingNodeId         = useWorkflowStore(s => s.editingNodeId);
  const setEditingNodeId      = useWorkflowStore(s => s.setEditingNodeId);
  const setPendingExpand      = useWorkflowStore(s => s.setPendingExpand);
  const pendingExpand         = useWorkflowStore(s => s.pendingExpand);
  const currentExploreNodeId  = useWorkflowStore(s => s.currentExploreNodeId);
  const isExploring           = currentExploreNodeId === id;
  const toggleNodeCollapsed   = useWorkflowStore(s => s.toggleNodeCollapsed);
  const allNodes              = useWorkflowStore(s => s.nodes);
  const childCount            = useMemo(() => allNodes.filter(n => n.data.parentId === id).length, [allNodes, id]);
  const isParent              = childCount > 0;
  const isCollapsed           = !!data.collapsed;

  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(data.label);

  // Dispatch to dedicated shape components
  if (data.nodeType === 'start' || data.nodeType === 'end') {
    return <CircleNode id={id} data={data} selected={selected} type={data.nodeType} dragging={false} isConnectable={true} positionAbsoluteX={0} positionAbsoluteY={0} zIndex={0} deletable={true} selectable={true} draggable={true} />;
  }
  const styles = TYPE_STYLES[data.nodeType] ?? TYPE_STYLES.task;
  const canExpand = EXPANDABLE.includes(data.nodeType) && pendingExpand?.nodeId !== id;

  useEffect(() => {
    if (editingNodeId === id) {
      setEditValue(data.label);
      setEditing(true);
      setEditingNodeId(null);
    }
  }, [editingNodeId, id, setEditingNodeId]);

  const startEdit = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setEditValue(data.label);
    setEditing(true);
  };

  const commitEdit = () => {
    setEditing(false);
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== data.label) updateNodeLabel(id, trimmed);
  };

  const handleExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
    setPendingExpand({ nodeId: id, nodeLabel: data.label });
  };

  const isSubtask = !!data.parentId;

  return (
    <div
      className={`
        group relative rounded-2xl border-2 ${styles.border}
        ${isSubtask ? 'bg-slate-100/80 border-dashed' : styles.bg}
        shadow-sm px-4 py-3 min-h-[68px]
        transition-shadow duration-150
        ${isExploring ? 'shadow-md ring-2 ring-indigo-400 ring-offset-2' : selected ? 'shadow-md ring-2 ring-blue-400 ring-offset-1' : 'hover:shadow-md'}
      `}
      style={{ width: NODE_WIDTH }}
      onDoubleClick={editing ? undefined : startEdit}
    >
      <Handle type="target" position={Position.Top} style={{ width: 8, height: 8, backgroundColor: '#94a3b8', border: '2px solid white', top: -4 }} />

      {isSubtask && (
        <div className="absolute -top-2 left-3 px-1.5 py-0.5 bg-slate-200 text-slate-500 text-[9px] font-semibold uppercase tracking-wider rounded-full leading-none">
          sub-step
        </div>
      )}

      {editing ? (
        <input
          autoFocus
          className="w-full text-sm font-semibold text-slate-800 leading-tight bg-transparent border-b-2 border-blue-400 outline-none pb-0.5 text-center"
          value={editValue}
          onChange={e => setEditValue(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={e => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditing(false); }}
        />
      ) : (
        <p className="text-sm font-semibold text-slate-800 text-center leading-tight">{data.label}</p>
      )}

      {data.description && !editing && (
        <p className="text-xs text-slate-500 text-center mt-1 leading-snug line-clamp-2">{data.description}</p>
      )}

      {/* Action row */}
      <div className="mt-2 flex items-center justify-center gap-1.5">
        {isParent && (
          <button
            onClick={e => { e.stopPropagation(); toggleNodeCollapsed(id); }}
            title={isCollapsed ? 'Expand sub-steps' : 'Collapse sub-steps'}
            className="text-[10px] flex items-center gap-1 px-2 py-0.5 rounded-full border border-indigo-200 bg-indigo-50/50 hover:bg-indigo-500 hover:text-white hover:border-indigo-500 text-indigo-600 transition-all font-medium"
          >
            <span>{isCollapsed ? '▶' : '▼'}</span>
            <span>{childCount}</span>
          </button>
        )}
        {!isParent && canExpand && !editing && (
          <button
            onClick={handleExpand}
            title="Break into sub-steps"
            className="text-[10px] text-blue-600 hover:text-white hover:bg-blue-500 border border-blue-200 hover:border-blue-500 bg-blue-50/50 px-2 py-0.5 rounded-full transition-all flex items-center gap-1 font-medium"
          >
            <span className="text-sm leading-none">+</span>
            <span>break down</span>
          </button>
        )}
        {pendingExpand?.nodeId === id && (
          <span className="text-[10px] text-blue-400 opacity-60 animate-pulse">expanding…</span>
        )}
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        className="opacity-0 group-hover:opacity-100 transition-opacity"
        style={{
          width: 22, height: 22, borderRadius: '50%', backgroundColor: 'white',
          border: '2px solid #60a5fa',
          backgroundImage: PLUS_SVG, backgroundSize: '10px 10px', backgroundRepeat: 'no-repeat', backgroundPosition: 'center',
          bottom: -11, left: '50%', transform: 'translateX(-50%)',
          cursor: 'crosshair', boxShadow: '0 1px 4px rgba(0,0,0,0.12)',
        }}
      />
    </div>
  );
}

// Walker highlight — a transparent halo behind the node being modified.
// Sits beneath the anchor so the anchor's content stays readable.
function WalkerHighlight() {
  return (
    <div
      className="rounded-2xl bg-violet-100/50 border-2 border-violet-400 border-dashed"
      style={{ width: '100%', height: '100%', pointerEvents: 'none' }}
    />
  );
}

// Insertion-point dot for missing-task gaps — a small violet circle on the existing edge,
// marking exactly where the new task would slot in. The card's connector line pulls
// off this dot so the user can trace the suggestion back to a precise location.
function WalkerInsertionDot() {
  return (
    <div
      className="rounded-full bg-violet-500 shadow-sm"
      style={{ width: '100%', height: '100%', pointerEvents: 'none' }}
    />
  );
}

// Walker ghost — a dashed-outline preview of a proposed node, shown while a gap card is open.
// Visually unified with the card: same violet accent, dashed border so it reads as "not yet real".
function WalkerGhost({ data }: NodeProps<Node<WorkflowNodeData, NodeType>>) {
  return (
    <div
      className="rounded-2xl border-2 border-dashed border-violet-300 bg-violet-50/60 px-4 py-3 min-h-[68px]"
      style={{ width: NODE_WIDTH, pointerEvents: 'none' }}
    >
      <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-violet-500 mb-1">
        ↓ preview
      </p>
      <p className="text-sm font-semibold text-slate-800 leading-tight">{data.label}</p>
      {data.description && <p className="text-xs text-slate-500 mt-1 leading-snug line-clamp-2">{data.description}</p>}
    </div>
  );
}

// Walker card — the floating interview card. Two kinds:
// • transition: a Yes/No question confirming the participant moves from one task to the next
// • decompose: a question + multi-select list of suggested sub-steps for a broad task
type Suggestion = { label: string; description: string; type: NodeType };
type WalkerCardData = WorkflowNodeData & {
  cardKind?: 'transition' | 'missing' | 'decompose';
  cardQuestion?: string;
  cardEdgeLabel?: string;
  cardProposedLabel?: string;
  cardSuggestions?: Suggestion[];
  onYes?: () => void;
  onNo?: () => void;
  onAdd?: (picked: Suggestion[]) => void;
  onSkip?: () => void;
};

function WalkerCard({ data }: NodeProps<Node<WalkerCardData, NodeType>>) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const k = data.cardKind ?? 'transition';

  if (k === 'transition') {
    return (
      <div
        className="bg-white rounded-2xl border-2 border-violet-200 shadow-lg px-5 py-4 w-[340px]"
        style={{ pointerEvents: 'auto' }}
      >
        <div className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] px-2.5 py-1 rounded-full bg-violet-100 text-violet-700">
          <span>→</span><span>Workflow check</span>
        </div>
        <p className="text-base font-semibold text-slate-800 leading-snug mt-3">
          {data.cardQuestion}
        </p>
        {data.cardEdgeLabel && (
          <p className="text-xs text-violet-600 mt-2 font-medium">
            <span className="text-slate-400">↳ flows:</span> {data.cardEdgeLabel}
          </p>
        )}
        <div className="flex gap-2 mt-4">
          <button
            onClick={data.onYes}
            className="flex-1 py-2 bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium rounded-lg transition flex items-center justify-center gap-1.5"
          >
            <span>✓</span><span>Yes, that's right</span>
          </button>
          <button
            onClick={data.onNo}
            className="flex-1 py-2 bg-white hover:bg-slate-50 border border-slate-200 text-slate-600 text-sm font-medium rounded-lg transition flex items-center justify-center gap-1.5"
          >
            <span>✗</span><span>Not really</span>
          </button>
        </div>
      </div>
    );
  }

  if (k === 'missing') {
    return (
      <div
        className="bg-white rounded-2xl border-2 border-violet-300 shadow-lg px-5 py-4 w-[340px]"
        style={{ pointerEvents: 'auto' }}
      >
        <div className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] px-2.5 py-1 rounded-full bg-violet-100 text-violet-700">
          <span>✦</span><span>Missing task?</span>
        </div>
        <p className="text-base font-semibold text-slate-800 leading-snug mt-3">
          {data.cardQuestion}
        </p>
        {data.cardProposedLabel && (
          <p className="text-sm text-violet-600 font-medium mt-2">
            ↳ would add: <span className="text-slate-700">"{data.cardProposedLabel}"</span>
          </p>
        )}
        <div className="flex gap-2 mt-4">
          <button
            onClick={data.onYes}
            className="flex-1 py-2 bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium rounded-lg transition flex items-center justify-center gap-1.5"
          >
            <span>+</span><span>Yes, insert task</span>
          </button>
          <button
            onClick={data.onNo}
            className="flex-1 py-2 bg-white hover:bg-slate-50 border border-slate-200 text-slate-600 text-sm font-medium rounded-lg transition flex items-center justify-center gap-1.5"
          >
            <span>✗</span><span>Skip</span>
          </button>
        </div>
      </div>
    );
  }

  // decompose
  const suggestions = data.cardSuggestions ?? [];
  const toggle = (i: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  };
  const handleAdd = () => {
    const picked = [...selected].map(i => suggestions[i]).filter(Boolean);
    data.onAdd?.(picked);
  };

  return (
    <div
      className="bg-white rounded-2xl border-2 border-blue-200 shadow-lg px-5 py-4 w-[360px]"
      style={{ pointerEvents: 'auto' }}
    >
      <div className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] px-2.5 py-1 rounded-full bg-blue-100 text-blue-700">
        <span>◧</span><span>Decompose</span>
      </div>
      <p className="text-base font-semibold text-slate-800 leading-snug mt-3">
        {data.cardQuestion}
      </p>
      <p className="text-xs text-slate-400 mt-1">Pick the sub-steps that apply:</p>
      <div className="space-y-1.5 mt-3 max-h-[280px] overflow-y-auto">
        {suggestions.map((s, i) => {
          const isSel = selected.has(i);
          return (
            <button
              key={i}
              onClick={() => toggle(i)}
              className={`w-full px-3 py-2 rounded-lg border text-left flex gap-2 items-start transition ${isSel ? 'border-blue-400 bg-blue-50' : 'border-slate-200 hover:border-blue-300 hover:bg-blue-50/40'}`}
            >
              <span className={`mt-0.5 w-4 h-4 rounded flex items-center justify-center text-[10px] font-bold shrink-0 ${isSel ? 'bg-blue-500 text-white' : 'border border-slate-300 text-transparent'}`}>
                ✓
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-700 leading-snug">{s.label}</p>
                {s.description && <p className="text-xs text-slate-500 leading-snug mt-0.5">{s.description}</p>}
              </div>
            </button>
          );
        })}
      </div>
      <div className="flex gap-2 mt-4">
        <button
          onClick={data.onSkip}
          className="px-3 py-2 bg-white hover:bg-slate-50 border border-slate-200 text-slate-500 text-sm font-medium rounded-lg transition"
        >
          Skip
        </button>
        <button
          onClick={handleAdd}
          disabled={selected.size === 0}
          className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-30 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition flex items-center justify-center gap-1.5"
        >
          <span>+</span><span>Add {selected.size > 0 ? selected.size : ''} sub-step{selected.size !== 1 ? 's' : ''}</span>
        </button>
      </div>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const nodeTypes: Record<string, any> = {
  start: WorkflowNode, task: WorkflowNode, decision: WorkflowNode,
  handoff: WorkflowNode, input: WorkflowNode, failure: WorkflowNode,
  wait: WorkflowNode, end: WorkflowNode,
  subtaskBackdrop: SubtaskBackdrop,
  walkerGhost: WalkerGhost,
  walkerCard: WalkerCard,
  walkerHighlight: WalkerHighlight,
  walkerInsertionDot: WalkerInsertionDot,
};
