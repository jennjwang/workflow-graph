import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import ReactMarkdown from 'react-markdown';
import { useWorkflowStore } from '../store';
import { sendChatMessage, saveSession, proposeSubtasks, proposeRelationships, ProposedEdge, analyzeGaps, GapItem } from '../lib/api';
import type { GraphUpdate } from '../types';

type SidebarPhase = 'extracting' | 'gaps' | 'relationships' | 'done';

const LENS_META: Record<string, { label: string; color: string; emoji: string; description: string }> = {
  breakdown:  { label: 'Break down',  color: 'bg-blue-100 text-blue-700',     emoji: '◧', description: 'A task that hides sub-steps' },
  dependency: { label: 'Dependency',  color: 'bg-emerald-100 text-emerald-700', emoji: '→', description: 'Something needed before / after' },
  handoff:    { label: 'Handoff',     color: 'bg-violet-100 text-violet-700', emoji: '⇆', description: 'Work passed to someone/something else' },
};

function summarizeProposal(change: GraphUpdate): string {
  if (change.tool === 'add_node') {
    const i = change.input as { label?: string; type?: string; parentId?: string };
    const sub = i.parentId ? ' sub-step' : '';
    return `+ ${i.type ?? 'node'}${sub}: ${i.label ?? '?'}`;
  }
  if (change.tool === 'add_edge') {
    const i = change.input as { source: string; target: string; label?: string };
    return `→ ${i.source} → ${i.target}${i.label ? ` (${i.label})` : ''}`;
  }
  return '';
}

const TYPE_BADGE: Record<string, { color: string; icon?: string; label: string }> = {
  start:    { color: 'bg-green-100 text-green-700',   icon: '▶', label: 'start' },
  task:     { color: 'bg-blue-100 text-blue-700',                label: 'task' },
  decision: { color: 'bg-orange-100 text-orange-700', icon: '◆', label: 'decision' },
  handoff:  { color: 'bg-violet-100 text-violet-700', icon: '⇆', label: 'handoff' },
  wait:     { color: 'bg-amber-100 text-amber-700',   icon: '◷', label: 'wait' },
  failure:  { color: 'bg-red-100 text-red-700',       icon: '!', label: 'failure' },
  end:      { color: 'bg-slate-100 text-slate-700',   icon: '■', label: 'end' },
};

const KICKOFF_HINT = (task: string) =>
  `Ask the participant exactly: "Can you walk me through how you ${task} from start to finish?"`;

export function WorkflowSidebar() {
  const {
    sessionId, coreTask, messages, isLoading,
    addMessage, setLoading, applyGraphUpdates, nodes, edges, getExportData,
    userProfile, selectedTasks, currentTaskIdx,
    advanceToNextTask, markNodeClarified, addChildNodes,
    pendingExpand, setPendingExpand,
  } = useWorkflowStore(useShallow(s => ({
    sessionId: s.sessionId,
    coreTask: s.coreTask,
    messages: s.messages,
    isLoading: s.isLoading,
    addMessage: s.addMessage,
    setLoading: s.setLoading,
    applyGraphUpdates: s.applyGraphUpdates,
    nodes: s.nodes,
    edges: s.edges,
    getExportData: s.getExportData,
    userProfile: s.userProfile,
    selectedTasks: s.selectedTasks,
    currentTaskIdx: s.currentTaskIdx,
    advanceToNextTask: s.advanceToNextTask,
    markNodeClarified: s.markNodeClarified,
    addChildNodes: s.addChildNodes,
    pendingExpand: s.pendingExpand,
    setPendingExpand: s.setPendingExpand,
  })));

  const [phase, setPhase] = useState<SidebarPhase>('extracting');
  const [proposedEdges, setProposedEdges] = useState<ProposedEdge[]>([]);
  const [edgeIdx, setEdgeIdx] = useState(0);
  const [edgesLoading, setEdgesLoading] = useState(false);

  // Gap-analysis driven follow-ups
  const [gaps, setGaps] = useState<GapItem[]>([]);
  const [gapIdx, setGapIdx] = useState(0);
  const [gapsLoading, setGapsLoading] = useState(false);


  // Expand-on-demand (from clicking "+ break down" on any node)
  const [expandSubtasks, setExpandSubtasks] = useState<{ label: string; description: string; type: import('../types').NodeType; linkToExistingId?: string }[]>([]);
  const [expandSelected, setExpandSelected] = useState<Set<number>>(new Set());
  const [expandLoading, setExpandLoading] = useState(false);
  const [expandCustom, setExpandCustom] = useState('');

  const hasKickedOff = useRef(false);

  // Kickoff: send participant's first answer to extract top-level nodes
  useEffect(() => {
    if (hasKickedOff.current) return;
    hasKickedOff.current = true;

    const existing = useWorkflowStore.getState().messages;
    if (existing.length === 0) return; // need a kickoff answer first

    setLoading(true);
    const taskPhrase = coreTask.charAt(0).toLowerCase() + coreTask.slice(1);
    const kickoffMsg = KICKOFF_HINT(taskPhrase);
    const allMessages = [
      { id: '__kickoff__', role: 'user' as const, content: kickoffMsg, timestamp: 0 },
      ...existing,
    ];

    sendChatMessage(
      allMessages, coreTask, [], true /* skipSuggestions on kickoff */, userProfile, selectedTasks, null,
      (u: GraphUpdate) => applyGraphUpdates([u]),
    ).then(({ message }) => {
      if (message) addMessage('assistant', message);
      setPhase('gaps');
    }).catch(err => {
      addMessage('assistant', `Error: ${err.message}`);
    }).finally(() => setLoading(false));
  }, []);

  // Gap analysis runs once, after extraction completes — surfaces breakdown / dependency / handoff gaps.
  useEffect(() => {
    if (phase !== 'gaps') return;
    if (gapsLoading || gaps.length > 0) return;
    if (nodes.length === 0) return;
    setGapsLoading(true);
    analyzeGaps(
      nodes.map(n => ({ id: n.id, type: n.data.nodeType, label: n.data.label, description: n.data.description })),
      edges.map(e => ({ source: e.source, target: e.target, label: typeof e.label === 'string' ? e.label : undefined })),
      coreTask,
      userProfile.jobTitle,
    ).then(items => {
      // Filter out gaps whose proposals all already exist in the graph
      const existingNodeIds = new Set(nodes.map(n => n.id));
      const existingEdgeKeys = new Set(edges.map(e => `${e.source}->${e.target}`));
      const filtered = items.filter(g => {
        const ops = g.proposed_changes ?? [];
        return ops.some(op => {
          if (op.tool === 'add_node') return !existingNodeIds.has((op.input as { id: string }).id);
          if (op.tool === 'add_edge') {
            const i = op.input as { source: string; target: string };
            return !existingEdgeKeys.has(`${i.source}->${i.target}`);
          }
          return false;
        });
      });
      setGaps(filtered);
      setGapIdx(0);
      if (filtered.length === 0) setPhase('relationships');
    }).catch(() => setPhase('relationships'))
     .finally(() => setGapsLoading(false));
  }, [phase]);

  useEffect(() => {
    if (phase !== 'relationships') return;
    if (edgesLoading || proposedEdges.length > 0) return;
    setEdgesLoading(true);
    proposeRelationships(
      nodes.map(n => ({ id: n.id, label: n.data.label })),
      coreTask,
      userProfile.jobTitle,
    ).then(eds => {
      // Filter out edges already in the graph
      const existingEdgeKeys = new Set(edges.map(e => `${e.source}->${e.target}`));
      setProposedEdges(eds.filter(e => !existingEdgeKeys.has(`${e.source}->${e.target}`)));
      setEdgeIdx(0);
    }).catch(() => {}).finally(() => setEdgesLoading(false));
  }, [phase]);

  // Watch for expand requests
  useEffect(() => {
    if (!pendingExpand) return;
    setExpandLoading(true);
    setExpandSubtasks([]);
    setExpandSelected(new Set());
    setExpandCustom('');
    const existingForExpand = nodes
      .filter(n => n.id !== pendingExpand.nodeId && n.data.parentId !== pendingExpand.nodeId)
      .map(n => ({ id: n.id, label: n.data.label, type: n.data.nodeType }));
    proposeSubtasks(pendingExpand.nodeLabel, coreTask, userProfile.jobTitle, undefined, existingForExpand)
      .then(setExpandSubtasks)
      .catch(() => {})
      .finally(() => setExpandLoading(false));
  }, [pendingExpand?.nodeId]);

  const confirmExpand = () => {
    if (!pendingExpand) return;
    const chosen = [...expandSelected].map(i => expandSubtasks[i]);
    const links = chosen.filter(c => (c as { linkToExistingId?: string }).linkToExistingId);
    const newSubs = chosen.filter(c => !(c as { linkToExistingId?: string }).linkToExistingId);
    if (newSubs.length > 0) addChildNodes(pendingExpand.nodeId, newSubs);
    // For linked subtasks: add an edge from parent to the existing node
    if (links.length > 0) {
      applyGraphUpdates(links.map(l => ({
        tool: 'add_edge' as const,
        input: { source: pendingExpand.nodeId, target: (l as { linkToExistingId: string }).linkToExistingId, label: 'connects to', is_branch: false },
      })));
    }
    setPendingExpand(null);
  };

  const cancelExpand = () => setPendingExpand(null);

  const addCustomExpand = () => {
    if (!expandCustom.trim()) return;
    const newSub = { label: expandCustom.trim(), description: '', type: 'task' as const };
    setExpandSubtasks(prev => [...prev, newSub]);
    setExpandSelected(prev => new Set([...prev, expandSubtasks.length]));
    setExpandCustom('');
  };

  // Gap handlers: walk the AI-proposed gaps one at a time. Each gap has one follow-up
  // question and a bundled set of proposed graph edits (add_node / add_edge).
  const currentGap = phase === 'gaps' ? gaps[gapIdx] : null;

  const acceptGap = () => {
    if (!currentGap) return;
    const ops = currentGap.proposed_changes ?? [];

    // For handoff/dependency slotting: detect new nodes wired between an existing A → B
    // and remove the now-redundant direct A → B edge.
    const newNodeIds = new Set(
      ops.filter(o => o.tool === 'add_node').map(o => (o.input as { id: string }).id)
    );
    const removeOps: GraphUpdate[] = [];
    for (const newId of newNodeIds) {
      const incoming = ops.find(o => o.tool === 'add_edge' && (o.input as { target: string }).target === newId);
      const outgoing = ops.find(o => o.tool === 'add_edge' && (o.input as { source: string }).source === newId);
      if (incoming && outgoing) {
        const a = (incoming.input as { source: string }).source;
        const b = (outgoing.input as { target: string }).target;
        if (edges.find(e => e.source === a && e.target === b)) {
          removeOps.push({ tool: 'remove_edge', input: { source: a, target: b } });
        }
      }
    }

    applyGraphUpdates([...ops, ...removeOps]);
    // Mark any breakdown parent as clarified so it won't re-prompt later
    for (const op of ops) {
      if (op.tool === 'add_node') {
        const pid = (op.input as { parentId?: string }).parentId;
        if (pid) markNodeClarified(pid);
      }
    }
    saveSession(sessionId, coreTask, { nodes: useWorkflowStore.getState().nodes, edges: useWorkflowStore.getState().edges }, useWorkflowStore.getState().messages).catch(() => {});
    nextGap();
  };

  const skipGap = () => nextGap();

  const nextGap = () => {
    if (gapIdx + 1 >= gaps.length) {
      setPhase('relationships');
    } else {
      setGapIdx(gapIdx + 1);
    }
  };

  // Relationship handling
  const currentEdgeProposal = phase === 'relationships' ? proposedEdges[edgeIdx] : null;

  const acceptEdge = () => {
    if (!currentEdgeProposal) return;
    applyGraphUpdates([{
      tool: 'add_edge',
      input: {
        source: currentEdgeProposal.source,
        target: currentEdgeProposal.target,
        label: currentEdgeProposal.label,
        is_branch: currentEdgeProposal.is_branch,
      },
    }]);
    nextEdge();
  };

  const rejectEdge = () => nextEdge();

  const nextEdge = () => {
    if (edgeIdx + 1 >= proposedEdges.length) {
      setPhase('done');
    } else {
      setEdgeIdx(edgeIdx + 1);
    }
  };

  const exportJSON = () => {
    const data = getExportData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `workflow-${sessionId.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const sourceNode = currentEdgeProposal ? nodes.find(n => n.id === currentEdgeProposal.source) : null;
  const targetNode = currentEdgeProposal ? nodes.find(n => n.id === currentEdgeProposal.target) : null;

  return (
    <div className="w-[400px] flex flex-col h-full bg-white border-l border-slate-100 shrink-0">
      {/* Header */}
      <div className="px-5 py-4 border-b border-slate-100 shrink-0 flex items-center justify-between">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-indigo-400">
            Task {currentTaskIdx + 1} of {selectedTasks.length}
          </p>
          <p className="text-sm font-semibold text-slate-700 truncate">{coreTask}</p>
          <p className="text-[10px] text-slate-400 mt-0.5 capitalize">
            {phase === 'extracting' ? 'Extracting tasks…' :
             phase === 'gaps' ? (gapsLoading ? 'Looking for gaps…' : gaps.length > 0 ? `Gap ${gapIdx + 1} of ${gaps.length}` : 'Looking for gaps…') :
             phase === 'relationships' ? `Mapping relationships ${edgeIdx + 1} of ${proposedEdges.length}` :
             'Complete'}
          </p>
        </div>
        <button
          onClick={exportJSON}
          className="text-[11px] text-slate-400 hover:text-slate-600 transition px-2 py-1 rounded-lg hover:bg-slate-50"
        >
          Export ↓
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5 min-h-0">
        {/* Expand-on-demand overlay (overrides phase content) */}
        {pendingExpand ? (
          <div className="space-y-4">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-blue-500 mb-1">
                Breaking down
              </p>
              <p className="text-xl font-light text-slate-800 leading-snug">
                "{pendingExpand.nodeLabel}"
              </p>
            </div>

            {expandLoading && (
              <div className="flex gap-2">
                {[0, 150, 300].map(d => (
                  <span key={d} className="w-2 h-2 bg-blue-200 rounded-full animate-bounce" style={{ animationDelay: `${d}ms` }} />
                ))}
              </div>
            )}

            {!expandLoading && expandSubtasks.length > 0 && (
              <>
                <p className="text-sm text-slate-600">
                  Pick the sub-steps that apply:
                </p>
                <div className="space-y-2">
                  {expandSubtasks.map((s, i) => {
                    const sel = expandSelected.has(i);
                    const badge = TYPE_BADGE[s.type] ?? TYPE_BADGE.task;
                    return (
                      <button
                        key={i}
                        onClick={() => setExpandSelected(prev => {
                          const next = new Set(prev);
                          next.has(i) ? next.delete(i) : next.add(i);
                          return next;
                        })}
                        className={`flex items-start gap-3 w-full px-3.5 py-3 rounded-xl border text-left transition-all
                          ${sel ? 'border-blue-400 bg-blue-50' : 'border-slate-200 hover:border-blue-300 hover:bg-blue-50/40'}`}
                      >
                        <span className={`mt-0.5 w-5 h-5 rounded flex items-center justify-center text-xs font-bold shrink-0 transition
                          ${sel ? 'bg-blue-500 text-white' : 'border border-slate-300 text-transparent'}`}>
                          ✓
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <p className="text-sm font-medium text-slate-700 leading-snug">{s.label}</p>
                            <span className={`text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${badge.color} shrink-0`}>
                              {badge.icon ? `${badge.icon} ` : ''}{badge.label}
                            </span>
                            {(s as { linkToExistingId?: string }).linkToExistingId && (
                              <span className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 shrink-0">
                                → connects to existing
                              </span>
                            )}
                          </div>
                          {s.description && <p className="text-xs text-slate-400 mt-0.5">{s.description}</p>}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* Add custom */}
                <div className="flex gap-2 pt-1">
                  <input
                    className="flex-1 border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                    placeholder="Add another sub-step…"
                    value={expandCustom}
                    onChange={e => setExpandCustom(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') addCustomExpand(); }}
                  />
                  <button
                    onClick={addCustomExpand}
                    disabled={!expandCustom.trim()}
                    className="px-3 py-2 text-sm bg-slate-100 hover:bg-slate-200 disabled:opacity-30 text-slate-600 rounded-xl transition"
                  >+</button>
                </div>

                <div className="flex gap-2 pt-2">
                  <button
                    onClick={confirmExpand}
                    className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-xl transition"
                  >
                    {expandSelected.size > 0
                      ? `Add ${expandSelected.size} sub-step${expandSelected.size !== 1 ? 's' : ''} →`
                      : 'Add nothing'}
                  </button>
                  <button
                    onClick={cancelExpand}
                    className="px-4 py-2.5 text-sm text-slate-500 hover:text-slate-700 transition"
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <>
        {/* Extracting phase */}
        {phase === 'extracting' && (
          <div className="space-y-3">
            <p className="text-base text-slate-700">Reading through your overview…</p>
            <div className="flex gap-2">
              {[0, 150, 300].map(d => (
                <span key={d} className="w-2 h-2 bg-indigo-200 rounded-full animate-bounce" style={{ animationDelay: `${d}ms` }} />
              ))}
            </div>
          </div>
        )}

        {/* Gaps phase — AI-driven follow-ups using three lenses: breakdown, dependency, handoff */}
        {phase === 'gaps' && (
          <div className="space-y-5">
            {gapsLoading && gaps.length === 0 && (
              <div className="space-y-3">
                <p className="text-base text-slate-700">Looking for gaps in your workflow…</p>
                <p className="text-xs text-slate-400">Checking for big-verb tasks, missing dependencies, and hidden handoffs.</p>
                <div className="flex gap-2">
                  {[0, 150, 300].map(d => (
                    <span key={d} className="w-2 h-2 bg-indigo-200 rounded-full animate-bounce" style={{ animationDelay: `${d}ms` }} />
                  ))}
                </div>
              </div>
            )}

            {!gapsLoading && currentGap && (() => {
              const meta = LENS_META[currentGap.lens] ?? LENS_META.breakdown;
              return (
                <div className="space-y-4">
                  <div>
                    <span className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full ${meta.color}`}>
                      <span>{meta.emoji}</span>
                      <span>{meta.label}</span>
                    </span>
                    <p className="text-[10px] text-slate-400 mt-1">{meta.description}</p>
                  </div>

                  <p className="text-base font-light text-slate-800 leading-snug">
                    {currentGap.question}
                  </p>

                  {currentGap.proposed_changes && currentGap.proposed_changes.length > 0 && (
                    <div className="border border-slate-200 rounded-xl p-3 bg-slate-50/50 space-y-1.5">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                        If yes, I'll add:
                      </p>
                      {currentGap.proposed_changes.map((c, i) => (
                        <p key={i} className="text-xs text-slate-600 font-mono leading-snug">
                          {summarizeProposal(c)}
                        </p>
                      ))}
                    </div>
                  )}

                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={acceptGap}
                      className="flex-1 py-2.5 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 text-emerald-700 text-sm font-medium rounded-xl transition"
                    >
                      ✓ Yes, add this
                    </button>
                    <button
                      onClick={skipGap}
                      className="flex-1 py-2.5 bg-slate-50 hover:bg-slate-100 border border-slate-200 text-slate-600 text-sm font-medium rounded-xl transition"
                    >
                      ✗ Not really
                    </button>
                  </div>
                </div>
              );
            })()}

            {!gapsLoading && gaps.length === 0 && (
              <div className="space-y-3">
                <p className="text-sm text-slate-500">No obvious gaps — your overview was thorough.</p>
                <button
                  onClick={() => setPhase('relationships')}
                  className="w-full py-2.5 bg-slate-800 hover:bg-slate-900 text-white text-sm font-medium rounded-xl transition"
                >
                  Continue →
                </button>
              </div>
            )}
          </div>
        )}

        {/* Relationships phase */}
        {phase === 'relationships' && (
          <div className="space-y-5">
            {edgesLoading && (
              <div className="space-y-3">
                <p className="text-base text-slate-700">Mapping how these tasks connect…</p>
                <div className="flex gap-2">
                  {[0, 150, 300].map(d => (
                    <span key={d} className="w-2 h-2 bg-indigo-200 rounded-full animate-bounce" style={{ animationDelay: `${d}ms` }} />
                  ))}
                </div>
              </div>
            )}

            {!edgesLoading && currentEdgeProposal && sourceNode && targetNode && (
              <div className="space-y-4">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-indigo-400">
                  Does this connection make sense?
                </p>

                <div className="space-y-2">
                  <div className="px-3 py-2.5 border border-slate-300 rounded-xl bg-slate-50">
                    <p className="text-[10px] text-slate-400 uppercase tracking-wide">From</p>
                    <p className="text-sm font-medium text-slate-700">{sourceNode.data.label}</p>
                  </div>
                  <div className="flex items-center justify-center gap-2 text-slate-400">
                    <span className="text-lg">↓</span>
                    {currentEdgeProposal.label && (
                      <span className="text-xs italic">{currentEdgeProposal.label}</span>
                    )}
                  </div>
                  <div className={`px-3 py-2.5 border rounded-xl ${currentEdgeProposal.is_branch ? 'border-amber-300 bg-amber-50' : 'border-slate-300 bg-slate-50'}`}>
                    <p className="text-[10px] text-slate-400 uppercase tracking-wide">To</p>
                    <p className="text-sm font-medium text-slate-700">{targetNode.data.label}</p>
                    {currentEdgeProposal.is_branch && (
                      <p className="text-[10px] text-amber-600 mt-0.5">Branch path</p>
                    )}
                  </div>
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={acceptEdge}
                    className="flex-1 py-2.5 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 text-emerald-700 text-sm font-medium rounded-xl transition"
                  >
                    ✓ Yes, that's right
                  </button>
                  <button
                    onClick={rejectEdge}
                    className="flex-1 py-2.5 bg-slate-50 hover:bg-slate-100 border border-slate-200 text-slate-600 text-sm font-medium rounded-xl transition"
                  >
                    ✗ Not really
                  </button>
                </div>
              </div>
            )}

            {!edgesLoading && proposedEdges.length === 0 && (
              <div className="space-y-3">
                <p className="text-sm text-slate-500">No more relationships to confirm.</p>
                <button
                  onClick={() => setPhase('done')}
                  className="w-full py-2.5 bg-slate-800 hover:bg-slate-900 text-white text-sm font-medium rounded-xl transition"
                >
                  Continue →
                </button>
              </div>
            )}
          </div>
        )}

        {/* Done phase */}
        {phase === 'done' && (
          <div className="space-y-4">
            <p className="text-xl font-light text-slate-800">Workflow mapped.</p>
            <p className="text-sm text-slate-500">
              {nodes.length} step{nodes.length !== 1 ? 's' : ''}, {edges.length} connection{edges.length !== 1 ? 's' : ''}.
            </p>
            {messages.length > 0 && (
              <div className="text-xs text-slate-400 italic space-y-1 mt-2">
                <p>Click <span className="text-blue-500 font-medium">+ break down</span> on any task to add sub-steps · drag to reposition · double-click to edit.</p>
              </div>
            )}
          </div>
        )}
        </>
        )}
      </div>

      {/* Footer — only show advance button once all clarification & relationship work is done */}
      {phase === 'done' && (
        <div className="shrink-0 px-5 py-4 border-t border-slate-100">
          <button
            onClick={advanceToNextTask}
            disabled={isLoading}
            className="w-full py-2.5 bg-slate-800 hover:bg-slate-900 disabled:opacity-30 text-white text-sm font-medium rounded-xl transition"
          >
            {currentTaskIdx + 1 < selectedTasks.length
              ? `Next task: ${selectedTasks[currentTaskIdx + 1]} →`
              : 'Finish mapping'}
          </button>
        </div>
      )}

      {/* Hidden ReactMarkdown import to keep the dep alive — used elsewhere in the app */}
      <div className="hidden"><ReactMarkdown>{''}</ReactMarkdown></div>
    </div>
  );
}
