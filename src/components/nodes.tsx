import { useEffect, useRef, useState, useMemo } from 'react';
import { Handle, Position, NodeProps, Node } from '@xyflow/react';
import { WorkflowNodeData, NodeType } from '../types';
import { useWorkflowStore } from '../store';

// A description that's just a restatement of the label adds no signal — hide
// it. Compare case-insensitively and ignore surrounding whitespace so trivial
// differences ("Run experiments" vs "run experiments ") still count as the
// same.
function descriptionAddsInfo(label: string, description?: string | null): boolean {
  if (!description) return false;
  const norm = (s: string) => s.trim().toLowerCase();
  return norm(description) !== norm(label);
}

// Subtask backdrop — a soft-bg container drawn behind the stacked sub-step cards.
function SubtaskBackdrop() {
  return (
    <div
      className="w-full h-full rounded-2xl bg-slate-100/70 border border-slate-200/80"
      style={{ pointerEvents: 'none' }}
    >
      <div className="px-3 pt-2 pointer-events-none select-none">
        <span className="text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-400">
          subtasks
        </span>
      </div>
    </div>
  );
}

type WorkflowFlowNode = Node<WorkflowNodeData, NodeType>;

const NODE_WIDTH = 220;

export function WorkflowNode({ id, data, selected }: NodeProps<WorkflowFlowNode>) {
  const updateNodeLabel       = useWorkflowStore(s => s.updateNodeLabel);
  const editingNodeId         = useWorkflowStore(s => s.editingNodeId);
  const setEditingNodeId      = useWorkflowStore(s => s.setEditingNodeId);
  const setPendingExpand      = useWorkflowStore(s => s.setPendingExpand);
  const pendingExpand         = useWorkflowStore(s => s.pendingExpand);
  const currentExploreNodeId  = useWorkflowStore(s => s.currentExploreNodeId);
  const isExploring           = currentExploreNodeId === id;
  const toggleNodeCollapsed   = useWorkflowStore(s => s.toggleNodeCollapsed);
  const addEmptySubtask       = useWorkflowStore(s => s.addEmptySubtask);
  const deleteNodes           = useWorkflowStore(s => s.deleteNodes);
  const tourSpotlightAddNode  = useWorkflowStore(s => s.tourSpotlightAddNode);
  const allNodes              = useWorkflowStore(s => s.nodes);
  const tourForcePlus         = tourSpotlightAddNode === id;
  const childCount            = useMemo(() => allNodes.filter(n => n.data.parentId === id).length, [allNodes, id]);
  const isParent              = childCount > 0;
  // Once the participant has kept any draft (in any task), they've learned the
  // click-to-keep gesture — drop the per-card hint everywhere from then on.
  const hasLearnedKeepGesture = useWorkflowStore(s => s.hasLearnedKeepGesture);
  const isCollapsed           = !!data.collapsed;

  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(data.label);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the textarea to fit its content while the participant types so
  // long labels wrap and stay fully visible instead of scrolling horizontally.
  useEffect(() => {
    if (!editing) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }, [editing, editValue]);

  const canExpand = pendingExpand?.nodeId !== id;

  useEffect(() => {
    if (editingNodeId === id) {
      setEditValue(data.label);
      setEditing(true);
      setEditingNodeId(null);
    }
  }, [editingNodeId, id, setEditingNodeId]);

  const commitEdit = () => {
    setEditing(false);
    const trimmed = editValue.trim();
    // A manually-added subtask must have a real name. If the participant
    // commits without changing the placeholder, treat the add as a no-op and
    // remove the node (which also reverses its add-bonus contribution).
    if (data.manuallyAdded && (!trimmed || trimmed === 'New subtask')) {
      deleteNodes([id]);
      return;
    }
    if (trimmed && trimmed !== data.label) updateNodeLabel(id, trimmed);
  };

  const handleExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
    setPendingExpand({ nodeId: id, nodeLabel: data.label });
  };

  const handleAddEmpty = (e: React.MouseEvent) => {
    e.stopPropagation();
    addEmptySubtask(id);
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    deleteNodes([id]);
  };

  const isDraft = data.confirmed === false;
  // Hover-revealed delete affordance: any non-root node. AI drafts can also be
  // discarded by click-to-unkeep, but explicit delete is needed for duplicates
  // or AI suggestions the participant wants gone from the canvas entirely.
  const canDelete = !!data.parentId;

  return (
    <div
      className={`
        group relative rounded-2xl px-4 py-3 min-h-[68px] transition-all duration-150
        ${isDraft
          ? 'border-2 border-dashed border-slate-300 bg-slate-50/70 cursor-pointer hover:border-blue-400 hover:bg-blue-50/40'
          : 'border border-slate-200 bg-white shadow-sm hover:shadow-md hover:border-slate-300'}
        ${isExploring ? 'shadow-md ring-2 ring-indigo-400 ring-offset-2' : selected ? 'shadow-md ring-2 ring-blue-400 ring-offset-1' : ''}
      `}
      style={{ width: NODE_WIDTH }}
    >
      <Handle type="target" position={Position.Left} style={{ width: 8, height: 8, backgroundColor: '#94a3b8', border: '2px solid white', left: -4 }} />

      {editing ? (
        <textarea
          ref={textareaRef}
          autoFocus
          rows={1}
          className="w-full text-sm font-semibold text-slate-800 leading-tight bg-transparent border-b-2 border-blue-400 outline-none pb-0.5 text-center resize-none overflow-hidden block"
          value={editValue}
          onClick={e => e.stopPropagation()}
          onMouseDown={e => e.stopPropagation()}
          onFocus={e => e.currentTarget.select()}
          onChange={e => setEditValue(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              commitEdit();
            }
            if (e.key === 'Escape') {
              setEditing(false);
              // Cancelling on a manually-added subtask that was never given a
              // real name discards the node entirely.
              if (data.manuallyAdded && (!data.label.trim() || data.label === 'New subtask')) {
                deleteNodes([id]);
              }
            }
          }}
        />
      ) : (
        <p className={`text-sm font-semibold text-center leading-tight break-words whitespace-pre-wrap ${isDraft ? 'text-slate-500' : 'text-slate-800'}`}>{data.label}</p>
      )}
      {!data.parentId && descriptionAddsInfo(data.label, data.description) && (
        <p className="text-[11px] text-slate-500 text-center leading-snug mt-1.5 whitespace-pre-wrap break-words">
          {data.description}
        </p>
      )}
      {isDraft && !hasLearnedKeepGesture && (
        <p className="text-[9px] text-slate-400 text-center mt-1 uppercase tracking-wide font-medium transition-opacity duration-300">tap to keep</p>
      )}
      {!isDraft && data.parentId && !hasLearnedKeepGesture && (
        <p className="text-[9px] text-slate-300 text-center mt-1 uppercase tracking-wide font-medium opacity-0 group-hover:opacity-100 transition-opacity">tap to unkeep</p>
      )}

      {/* Action row */}
      <div className="mt-2 flex items-center justify-center gap-1.5">
        {isParent && (
          <button
            onClick={e => { e.stopPropagation(); toggleNodeCollapsed(id); }}
            title={isCollapsed ? 'Expand subtasks' : 'Collapse subtasks'}
            className="text-[10px] flex items-center gap-1 px-2 py-0.5 rounded-full border border-indigo-200 bg-indigo-50/50 hover:bg-indigo-500 hover:text-white hover:border-indigo-500 text-indigo-600 transition-all font-medium"
          >
            <span>{isCollapsed ? '▶' : '▼'}</span>
            <span>{childCount}</span>
          </button>
        )}
        {canExpand && !editing && (
          <button
            onClick={handleExpand}
            title={isParent ? 'Suggest more subtasks with AI' : 'Suggest subtasks with AI'}
            className="text-[10px] text-blue-600 hover:text-white hover:bg-blue-500 border border-blue-200 hover:border-blue-500 bg-blue-50/50 px-2 py-0.5 rounded-full transition-all flex items-center gap-1 font-medium"
          >
            <span className="text-sm leading-none">✦</span>
            <span>{isParent ? 'more subtasks' : 'subtasks'}</span>
          </button>
        )}
        {pendingExpand?.nodeId === id && (
          <span className="text-[10px] text-blue-400 opacity-60 animate-pulse">expanding…</span>
        )}
      </div>

      {/* Quick-add: hover-revealed plus at the right-center for adding an empty subtask. */}
      {!editing && (
        <button
          onMouseDown={e => e.stopPropagation()}
          onClick={handleAddEmpty}
          title="Add an empty subtask"
          className={`${tourForcePlus ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} transition-opacity absolute top-1/2 -right-3 w-6 h-6 rounded-full border-2 border-blue-400 bg-white text-blue-500 hover:bg-blue-500 hover:text-white grid place-items-center shadow-sm z-10`}
          style={{ transform: 'translateY(-50%)' }}
        >
          <svg viewBox="0 0 24 24" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      )}

      {/* Delete: hover-revealed × at the top-right. Available on every non-root
          node so participants can also remove AI drafts and duplicates outright. */}
      {!editing && canDelete && (
        <button
          onMouseDown={e => e.stopPropagation()}
          onClick={handleDelete}
          title="Delete this subtask"
          className="opacity-0 group-hover:opacity-100 transition-opacity absolute -top-2 -right-2 w-5 h-5 rounded-full border border-slate-300 bg-white text-slate-400 hover:bg-rose-500 hover:text-white hover:border-rose-500 grid place-items-center shadow-sm z-10"
        >
          <svg viewBox="0 0 24 24" className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      )}

      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        style={{ width: 1, height: 1, opacity: 0, right: 0 }}
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
      {descriptionAddsInfo(data.label, data.description) && <p className="text-xs text-slate-500 mt-1 leading-snug line-clamp-2">{data.description}</p>}
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
      <p className="text-xs text-slate-400 mt-1">Pick the subtasks that apply:</p>
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
                {descriptionAddsInfo(s.label, s.description) && <p className="text-xs text-slate-500 leading-snug mt-0.5">{s.description}</p>}
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
          <span>+</span><span>Add {selected.size > 0 ? selected.size : ''} subtask{selected.size !== 1 ? 's' : ''}</span>
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
