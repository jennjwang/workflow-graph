import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useWorkflowStore } from '../store';
import { WorkflowCanvas } from './WorkflowCanvas';
import { suggestActors } from '../lib/api';

export function ActorAssignment() {
  const {
    nodes, messages, userProfile,
    actorPool, addActor, updateNodeActor, setPhase,
  } = useWorkflowStore(useShallow(s => ({
    nodes: s.nodes,
    messages: s.messages,
    userProfile: s.userProfile,
    actorPool: s.actorPool,
    addActor: s.addActor,
    updateNodeActor: s.updateNodeActor,
    setPhase: s.setPhase,
  })));

  const [customInput, setCustomInput] = useState('');
  const [showCustom, setShowCustom] = useState(false);
  const customRef = useRef<HTMLInputElement>(null);
  const fetchedRef = useRef(false);

  // Suggest actors from transcript on mount
  useEffect(() => {
    if (fetchedRef.current || !userProfile.jobTitle) return;
    fetchedRef.current = true;
    const transcript = messages.map(m => `${m.role}: ${m.content}`).join('\n');
    suggestActors(transcript, userProfile.jobTitle).then(actors => {
      actors.forEach(a => addActor(a));
    }).catch(() => {});
  }, []);

  const allNodes = nodes;
  const assignedCount = allNodes.filter(n => n.data.actor).length;
  const canProceed = assignedCount === allNodes.length && allNodes.length > 0;

  const submitCustom = () => {
    const t = customInput.trim();
    if (!t) return;
    addActor(t);
    setCustomInput('');
    setShowCustom(false);
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      {/* Canvas */}
      <div className="flex-1 min-w-0">
        <WorkflowCanvas />
      </div>

      {/* Actor assignment panel */}
      <div className="w-[400px] flex flex-col h-full bg-white border-l border-slate-100 shrink-0">
        {/* Header */}
        <div className="px-6 py-5 border-b border-slate-100 shrink-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-indigo-400 mb-1">Stage 2 of 2</p>
          <h2 className="text-lg font-semibold text-slate-800">Who does each step?</h2>
          <p className="text-sm text-slate-400 mt-1">Assign an actor to each step to build the swimlane view.</p>

          {/* Progress */}
          <div className="mt-3 space-y-1">
            <div className="flex justify-between text-xs text-slate-400">
              <span>{assignedCount} of {allNodes.length} assigned</span>
              <span>{Math.round((assignedCount / Math.max(allNodes.length, 1)) * 100)}%</span>
            </div>
            <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-indigo-400 to-violet-400 rounded-full transition-all duration-300"
                style={{ width: `${(assignedCount / Math.max(allNodes.length, 1)) * 100}%` }}
              />
            </div>
          </div>
        </div>

        {/* Node list */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-2 min-h-0">
          {allNodes.map(node => {
            const actor = node.data.actor as string | undefined;
            return (
              <div key={node.id} className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-700 truncate">{node.data.label}</p>
                  <p className="text-[10px] text-slate-400 capitalize">{node.data.nodeType}</p>
                </div>
                <select
                  value={actor ?? ''}
                  onChange={e => e.target.value && updateNodeActor(node.id, e.target.value)}
                  className={`text-sm border rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-300 transition shrink-0
                    ${actor
                      ? 'border-indigo-300 bg-indigo-50 text-indigo-800 font-medium'
                      : 'border-slate-200 bg-white text-slate-400'}`}
                >
                  <option value="">Assign…</option>
                  {actorPool.map(a => (
                    <option key={a} value={a}>{a}</option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>

        {/* Add custom actor + proceed */}
        <div className="px-6 py-5 border-t border-slate-100 shrink-0 space-y-3">
          {showCustom ? (
            <div className="flex gap-2">
              <input
                ref={customRef}
                autoFocus
                className="flex-1 border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                placeholder="e.g. Tech Lead, GitHub Actions…"
                value={customInput}
                onChange={e => setCustomInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') submitCustom();
                  if (e.key === 'Escape') { setShowCustom(false); setCustomInput(''); }
                }}
              />
              <button
                onClick={submitCustom}
                disabled={!customInput.trim()}
                className="px-3 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-30 text-white text-sm rounded-xl transition"
              >
                Add
              </button>
            </div>
          ) : (
            <button
              onClick={() => { setShowCustom(true); setTimeout(() => customRef.current?.focus(), 50); }}
              className="text-sm text-slate-400 hover:text-indigo-500 transition"
            >
              + Add actor
            </button>
          )}

          <button
            onClick={() => setPhase('handoff-interview')}
            disabled={!canProceed}
            className="w-full py-3 bg-slate-800 hover:bg-slate-900 disabled:opacity-30 disabled:cursor-not-allowed
                       text-white text-sm font-medium rounded-xl transition-all"
          >
            {canProceed ? 'Map handoffs →' : `Assign all ${allNodes.length - assignedCount} remaining steps first`}
          </button>
        </div>
      </div>
    </div>
  );
}
