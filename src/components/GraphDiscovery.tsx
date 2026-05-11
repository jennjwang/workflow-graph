import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, Background, Controls, NodeProps, Node, Edge,
  NodeTypes, applyNodeChanges, NodeChange, useReactFlow, ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';
import { useShallow } from 'zustand/react/shallow';
import { useWorkflowStore } from '../store';
import { expandDiscoveryNode } from '../lib/api';
import { DiscoveryNodeData, DiscoveryLevel, DiscoveryFrequency, DiscoveryAiUse } from '../types';

const LEVEL_STYLES = {
  role:    { border: 'border-slate-400',  bg: 'bg-slate-50',   text: 'text-slate-700' },
  task:    { border: 'border-indigo-300', bg: 'bg-white',      text: 'text-slate-800' },
  subtask: { border: 'border-teal-300',   bg: 'bg-teal-50/60', text: 'text-slate-700' },
};

const STATUS_RING = {
  unreviewed: '',
  confirmed: 'ring-2 ring-emerald-400 ring-offset-1',
  rejected: 'opacity-40',
};

const NODE_W = 190;
const NODE_H = 52;

function layoutTree(nodes: Node<DiscoveryNodeData>[], edges: { source: string; target: string }[]) {
  if (nodes.length === 0) return nodes;
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: 24, ranksep: 70 });
  nodes.forEach(n => g.setNode(n.id, { width: NODE_W, height: NODE_H }));
  edges.forEach(e => g.setEdge(e.source, e.target));
  dagre.layout(g);
  return nodes.map(n => {
    const pos = g.node(n.id);
    return { ...n, position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 } };
  });
}

function DiscoveryNode({ id, data }: NodeProps<Node<DiscoveryNodeData>>) {
  const { setDiscoveryNodeLoading, setDiscoveryNodeExpanded, discoveryReviewIdx, discoveryNodes, userProfile } =
    useWorkflowStore(useShallow(s => ({
      setDiscoveryNodeLoading: s.setDiscoveryNodeLoading,
      setDiscoveryNodeExpanded: s.setDiscoveryNodeExpanded,
      discoveryReviewIdx: s.discoveryReviewIdx,
      discoveryNodes: s.discoveryNodes,
      userProfile: s.userProfile,
    })));

  const st = LEVEL_STYLES[data.level] ?? LEVEL_STYLES.task;
  const reviewableTasks = discoveryNodes.filter(n => n.data.level !== 'role');
  const isCurrentReview = reviewableTasks[discoveryReviewIdx]?.id === id;

  const handleExpand = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setDiscoveryNodeLoading(id, true);
    try {
      const { children } = await expandDiscoveryNode(
        userProfile.jobTitle, data.label, data.level, []
      );
      setDiscoveryNodeExpanded(id, children.map(c => ({ ...c, level: c.level as DiscoveryLevel })));
    } catch {
      setDiscoveryNodeLoading(id, false);
    }
  };

  const canExpand = data.hasChildren && !data.expanded && data.level !== 'subtask';

  return (
    <div
      className={`
        relative rounded-xl border-2 ${st.border} ${st.bg}
        px-3 py-2 flex items-center gap-2 shadow-sm transition-all
        ${STATUS_RING[data.status]}
        ${isCurrentReview ? 'shadow-md ring-2 ring-indigo-400 ring-offset-1' : ''}
      `}
      style={{ width: NODE_W, minHeight: NODE_H }}
    >
      {/* Status dot */}
      {data.status !== 'unreviewed' && (
        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${data.status === 'confirmed' ? 'bg-emerald-400' : 'bg-slate-300'}`} />
      )}

      <span className={`text-xs font-medium ${st.text} leading-snug flex-1 select-none line-clamp-2`}>{data.label}</span>

      {data.loading ? (
        <svg className="w-3.5 h-3.5 text-slate-300 animate-spin flex-shrink-0" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
        </svg>
      ) : canExpand ? (
        <button
          onClick={handleExpand}
          className="w-5 h-5 rounded-full bg-slate-100 hover:bg-indigo-500 hover:text-white text-slate-400 flex items-center justify-center text-xs font-bold flex-shrink-0 transition-all"
        >+</button>
      ) : null}
    </div>
  );
}

const discoveryNodeTypes: NodeTypes = { discovery: DiscoveryNode as never };

const FREQUENCY_OPTIONS: { value: DiscoveryFrequency; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'rarely', label: 'Rarely' },
];

const AI_USE_OPTIONS: { value: DiscoveryAiUse; label: string }[] = [
  { value: 'yes', label: 'Yes' },
  { value: 'sometimes', label: 'Sometimes' },
  { value: 'no', label: 'No' },
];

const AI_HOW_OPTIONS = ['Drafting', 'Summarizing', 'Research', 'Code generation', 'Reviewing', 'Other'];

function ReviewSidebar() {
  const {
    discoveryNodes, discoveryReviewIdx, setDiscoveryReviewIdx,
    updateDiscoveryNode, addDiscoveryTask, selectedDiscoveryTasks,
    setPhase, setCoreTask,
  } = useWorkflowStore(useShallow(s => ({
    discoveryNodes: s.discoveryNodes,
    discoveryReviewIdx: s.discoveryReviewIdx,
    setDiscoveryReviewIdx: s.setDiscoveryReviewIdx,
    updateDiscoveryNode: s.updateDiscoveryNode,
    addDiscoveryTask: s.addDiscoveryTask,
    selectedDiscoveryTasks: s.selectedDiscoveryTasks,
    setPhase: s.setPhase,
    setCoreTask: s.setCoreTask,
  })));

  const { fitView } = useReactFlow();
  const reviewableTasks = discoveryNodes.filter(n => n.data.level !== 'role');
  const current = reviewableTasks[discoveryReviewIdx] ?? null;

  const [editLabel, setEditLabel] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [customInput, setCustomInput] = useState('');
  const [showCustom, setShowCustom] = useState(false);
  const customRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (current) {
      setEditLabel(current.data.label);
      setIsEditing(false);
      fitView({ nodes: [{ id: current.id }], duration: 400, padding: 0.5 });
    }
  }, [current?.id]);

  const reviewedCount = reviewableTasks.filter(n => n.data.status !== 'unreviewed').length;
  const confirmedCount = selectedDiscoveryTasks.length;
  const allReviewed = reviewedCount === reviewableTasks.length && reviewableTasks.length > 0;

  const respond = (patch: Partial<DiscoveryNodeData>) => {
    if (!current) return;
    const label = isEditing ? editLabel.trim() : current.data.label;
    updateDiscoveryNode(current.id, { ...patch, label: label || current.data.label });
  };

  const confirmTask = () => {
    respond({ status: 'confirmed' });
  };

  const rejectTask = () => {
    respond({ status: 'rejected' });
    advance();
  };

  const advance = () => {
    if (discoveryReviewIdx < reviewableTasks.length - 1) {
      setDiscoveryReviewIdx(discoveryReviewIdx + 1);
    }
  };

  const handleStart = () => {
    if (selectedDiscoveryTasks.length === 0) return;
    const firstNode = discoveryNodes.find(n => n.id === selectedDiscoveryTasks[0]);
    setCoreTask(firstNode?.data.label ?? '');
    useWorkflowStore.setState({
      selectedTasks: selectedDiscoveryTasks.map(id => discoveryNodes.find(n => n.id === id)?.data.label ?? '').filter(Boolean),
    });
    setPhase('workflow-kickoff');
  };

  const step = current ? (
    current.data.status === 'unreviewed' ? 'confirm' :
    current.data.status === 'confirmed' && !current.data.frequency ? 'frequency' :
    current.data.status === 'confirmed' && current.data.frequency && !current.data.aiUse ? 'ai-use' :
    current.data.status === 'confirmed' && current.data.aiUse && current.data.aiUse !== 'no' && !current.data.aiHowSo ? 'ai-how' :
    'done'
  ) : 'done';

  const isDone = step === 'done' || current?.data.status === 'rejected';

  return (
    <div className="w-[360px] flex flex-col h-full bg-white border-l border-slate-100 shrink-0">
      {/* Header */}
      <div className="px-6 py-5 border-b border-slate-100 shrink-0">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-indigo-400 mb-1">Task Discovery</p>
        <div className="space-y-1.5 mt-3">
          <div className="flex justify-between text-xs text-slate-400">
            <span>{reviewedCount} of {reviewableTasks.length} reviewed · {confirmedCount} confirmed</span>
          </div>
          <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-indigo-400 to-violet-400 rounded-full transition-all duration-300"
              style={{ width: `${reviewableTasks.length > 0 ? (reviewedCount / reviewableTasks.length) * 100 : 0}%` }}
            />
          </div>
        </div>
      </div>

      {/* Review area */}
      <div className="flex-1 overflow-y-auto px-6 py-6 min-h-0">
        {!current ? (
          <div className="flex gap-2 items-center">
            {[0, 150, 300].map(d => <span key={d} className="w-2 h-2 bg-indigo-200 rounded-full animate-bounce" style={{ animationDelay: `${d}ms` }} />)}
          </div>
        ) : (
          <div className="space-y-6">
            {/* Task name */}
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-2">
                Task {discoveryReviewIdx + 1} of {reviewableTasks.length}
              </p>
              {isEditing ? (
                <input
                  autoFocus
                  className="w-full text-xl font-light text-slate-800 bg-transparent border-b-2 border-indigo-400 outline-none pb-1"
                  value={editLabel}
                  onChange={e => setEditLabel(e.target.value)}
                  onBlur={() => { setIsEditing(false); if (editLabel.trim()) updateDiscoveryNode(current.id, { label: editLabel.trim() }); }}
                  onKeyDown={e => { if (e.key === 'Enter') { setIsEditing(false); if (editLabel.trim()) updateDiscoveryNode(current.id, { label: editLabel.trim() }); } }}
                />
              ) : (
                <button
                  className="text-xl font-light text-slate-800 leading-snug text-left hover:text-indigo-600 transition group"
                  onDoubleClick={() => setIsEditing(true)}
                  title="Double-click to edit"
                >
                  {current.data.label}
                  <span className="text-xs text-slate-300 group-hover:text-indigo-300 ml-2 hidden group-hover:inline">edit</span>
                </button>
              )}
            </div>

            {/* Step: confirm/reject */}
            {step === 'confirm' && (
              <div className="space-y-3">
                <p className="text-sm text-slate-500">Is this part of your role?</p>
                <div className="flex gap-3">
                  <button
                    onClick={confirmTask}
                    className="flex-1 py-2.5 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 text-emerald-700 font-medium text-sm rounded-xl transition"
                  >
                    ✓ Yes
                  </button>
                  <button
                    onClick={rejectTask}
                    className="flex-1 py-2.5 bg-slate-50 hover:bg-slate-100 border border-slate-200 text-slate-500 font-medium text-sm rounded-xl transition"
                  >
                    ✗ Not really
                  </button>
                </div>
              </div>
            )}

            {/* Step: frequency */}
            {step === 'frequency' && (
              <div className="space-y-3">
                <p className="text-sm text-slate-500">How often do you do this?</p>
                <div className="grid grid-cols-2 gap-2">
                  {FREQUENCY_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => { respond({ frequency: opt.value }); advance(); }}
                      className="py-2.5 border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50 text-sm font-medium text-slate-600 rounded-xl transition"
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Step: AI use */}
            {step === 'ai-use' && (
              <div className="space-y-3">
                <p className="text-sm text-slate-500">Do you use AI for this?</p>
                <div className="flex gap-2">
                  {AI_USE_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => {
                        respond({ aiUse: opt.value });
                        if (opt.value === 'no') advance();
                      }}
                      className="flex-1 py-2.5 border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50 text-sm font-medium text-slate-600 rounded-xl transition"
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Step: AI how */}
            {step === 'ai-how' && (
              <div className="space-y-3">
                <p className="text-sm text-slate-500">How? (select all that apply)</p>
                <div className="flex flex-wrap gap-2">
                  {AI_HOW_OPTIONS.map(opt => {
                    const sel = current.data.aiHowSo?.includes(opt);
                    return (
                      <button
                        key={opt}
                        onClick={() => {
                          const prev = current.data.aiHowSo ?? [];
                          const next = sel ? prev.filter(h => h !== opt) : [...prev, opt];
                          respond({ aiHowSo: next });
                        }}
                        className={`px-3 py-1.5 rounded-xl text-sm border transition ${sel ? 'bg-indigo-500 border-indigo-500 text-white' : 'border-slate-200 text-slate-600 hover:border-indigo-300'}`}
                      >
                        {opt}
                      </button>
                    );
                  })}
                </div>
                <button
                  onClick={advance}
                  disabled={!current.data.aiHowSo?.length}
                  className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-30 text-white text-sm font-medium rounded-xl transition"
                >
                  Next →
                </button>
              </div>
            )}

            {/* Done with this task */}
            {isDone && !allReviewed && (
              <button
                onClick={advance}
                className="w-full py-2.5 border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50 text-sm text-slate-600 rounded-xl transition"
              >
                Next task →
              </button>
            )}
          </div>
        )}
      </div>

      {/* Add custom task */}
      <div className="px-6 py-4 border-t border-slate-100 shrink-0 space-y-3">
        {showCustom ? (
          <div className="flex gap-2">
            <input
              ref={customRef}
              autoFocus
              className="flex-1 border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
              placeholder="e.g. Write job descriptions…"
              value={customInput}
              onChange={e => setCustomInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && customInput.trim()) { addDiscoveryTask(customInput.trim()); setCustomInput(''); setShowCustom(false); }
                if (e.key === 'Escape') { setShowCustom(false); setCustomInput(''); }
              }}
            />
            <button
              onClick={() => { if (customInput.trim()) { addDiscoveryTask(customInput.trim()); setCustomInput(''); setShowCustom(false); } }}
              disabled={!customInput.trim()}
              className="px-3 py-2 bg-indigo-600 disabled:opacity-30 text-white text-sm rounded-xl transition"
            >Add</button>
          </div>
        ) : (
          <button
            onClick={() => { setShowCustom(true); setTimeout(() => customRef.current?.focus(), 50); }}
            className="text-sm text-slate-400 hover:text-indigo-500 transition"
          >
            + Add a missing task
          </button>
        )}

        <button
          onClick={handleStart}
          disabled={confirmedCount === 0}
          className="w-full py-3 bg-slate-800 hover:bg-slate-900 disabled:opacity-30 disabled:cursor-not-allowed text-white text-sm font-medium rounded-xl transition"
        >
          {confirmedCount > 0 ? `Map ${confirmedCount} task${confirmedCount > 1 ? 's' : ''} →` : 'Confirm tasks to continue'}
        </button>
      </div>
    </div>
  );
}

export function GraphDiscovery() {
  const {
    discoveryNodes, discoveryEdges, userProfile, selectedTasks,
  } = useWorkflowStore(useShallow(s => ({
    discoveryNodes: s.discoveryNodes,
    discoveryEdges: s.discoveryEdges,
    selectedTasks: s.selectedTasks,
    userProfile: s.userProfile,
  })));

  const [rfNodes, setRfNodes] = useState<Node<DiscoveryNodeData>[]>([]);
  const initialized = useRef(false);

  const laidNodes = useMemo(
    () => layoutTree(discoveryNodes, discoveryEdges.map(e => ({ source: e.source, target: e.target }))),
    [discoveryNodes, discoveryEdges]
  );

  useEffect(() => { setRfNodes(laidNodes); }, [laidNodes]);

  useEffect(() => {
    if (initialized.current || !userProfile.jobTitle) return;
    initialized.current = true;
    const rootId = 'root_role';
    const tasks = selectedTasks.length > 0 ? selectedTasks : [userProfile.jobTitle];
    const rootNode: Node<DiscoveryNodeData> = {
      id: rootId, type: 'discovery', position: { x: 0, y: 0 },
      data: { label: userProfile.jobTitle, level: 'role', expanded: true, loading: false, hasChildren: false, status: 'unreviewed' },
    };
    const taskNodes: Node<DiscoveryNodeData>[] = tasks.map((label, i) => ({
      id: `task_${i}`,
      type: 'discovery',
      position: { x: 0, y: 0 },
      data: { label, level: 'task' as DiscoveryLevel, expanded: false, loading: false, hasChildren: true, status: 'unreviewed' as const },
    }));
    const taskEdges: Edge[] = tasks.map((_, i) => ({
      id: `${rootId}->task_${i}`,
      source: rootId, target: `task_${i}`,
      style: { stroke: '#e2e8f0', strokeWidth: 2 },
    }));
    useWorkflowStore.setState({ discoveryNodes: [rootNode, ...taskNodes], discoveryEdges: taskEdges });
  }, [userProfile.jobTitle]);

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    setRfNodes(nds => applyNodeChanges(changes, nds) as Node<DiscoveryNodeData>[]);
  }, []);

  return (
    <ReactFlowProvider>
    <div className="flex h-screen w-screen overflow-hidden bg-slate-50">
      <div className="flex-1 min-w-0 relative">
        <ReactFlow
          nodes={rfNodes}
          edges={discoveryEdges}
          nodeTypes={discoveryNodeTypes}
          onNodesChange={handleNodesChange}
          nodesDraggable={false}
          nodesConnectable={false}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} color="#e2e8f0" />
          <Controls className="!shadow-sm !border !border-gray-200 !rounded-lg overflow-hidden" />
        </ReactFlow>
      </div>
      <ReviewSidebar />
    </div>
    </ReactFlowProvider>
  );
}
