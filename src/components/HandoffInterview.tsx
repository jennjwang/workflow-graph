import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useWorkflowStore } from '../store';
import { WorkflowCanvas } from './WorkflowCanvas';
import { sendHandoffMessage } from '../lib/api';
import { SuggestionSet } from '../lib/api';
import { v4 as uuidv4 } from 'uuid';

export function HandoffInterview() {
  const {
    nodes, edges, coreTask, userProfile,
    setLoading, isLoading, applyGraphUpdates, setPhase, getExportData, sessionId,
  } = useWorkflowStore(useShallow(s => ({
    nodes: s.nodes,
    edges: s.edges,
    coreTask: s.coreTask,
    userProfile: s.userProfile,
    setLoading: s.setLoading,
    isLoading: s.isLoading,
    applyGraphUpdates: s.applyGraphUpdates,
    setPhase: s.setPhase,
    getExportData: s.getExportData,
    sessionId: s.sessionId,
  })));

  const [handoffMessages, setHandoffMessages] = useState<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: number }[]>([]);
  const [suggestions, setSuggestions] = useState<SuggestionSet | null>(null);
  const [answer, setAnswer] = useState('');
  const [selectedCards, setSelectedCards] = useState<Set<number>>(new Set());
  const [showTextInput, setShowTextInput] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const hasKickedOff = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const nodeSnapshot = nodes.map(n => ({ id: n.id, type: n.type as string, label: n.data.label, actor: n.data.actor as string | undefined }));
  const edgeSnapshot = edges.map(e => ({ source: e.source, target: e.target }));

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || isLoading) return;
    setAnswer('');
    setShowTextInput(false);
    setSuggestions(null);
    setSelectedCards(new Set());
    const userMsg = { id: uuidv4(), role: 'user' as const, content, timestamp: Date.now() };
    setHandoffMessages(prev => [...prev, userMsg]);
    setLoading(true);
    try {
      const allMsgs = [...handoffMessages, userMsg];
      const { message } = await sendHandoffMessage(
        allMsgs, nodeSnapshot, edgeSnapshot, coreTask, userProfile,
        (u) => applyGraphUpdates([u]),
        (items) => setSuggestions({ prompt: null, items }),
      );
      if (message) setHandoffMessages(prev => [...prev, { id: uuidv4(), role: 'assistant', content: message, timestamp: Date.now() }]);
    } catch (err: unknown) {
      setHandoffMessages(prev => [...prev, { id: uuidv4(), role: 'assistant', content: `Error: ${err instanceof Error ? err.message : String(err)}`, timestamp: Date.now() }]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (hasKickedOff.current) return;
    hasKickedOff.current = true;
    setLoading(true);
    sendHandoffMessage(
      [], nodeSnapshot, edgeSnapshot, coreTask, userProfile,
      (u) => applyGraphUpdates([u]),
      (items) => setSuggestions({ prompt: null, items }),
    ).then(({ message }) => {
      if (message) setHandoffMessages([{ id: uuidv4(), role: 'assistant', content: message, timestamp: Date.now() }]);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [handoffMessages, isLoading]);

  const hasSuggestions = !!(suggestions?.items.length && !isLoading);

  const confirmSelected = () => {
    if (!suggestions || selectedCards.size === 0) return;
    const labels = [...selectedCards].sort().map(i => suggestions.items[i].label);
    send(labels.join(', '));
  };

  const exportJSON = () => {
    const data = getExportData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = `workflow-${sessionId.slice(0, 8)}.json`; a.click();
    URL.revokeObjectURL(url);
  };

  const currentQuestion = [...handoffMessages].reverse().find(m => m.role === 'assistant')?.content ?? '';

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <div className="flex-1 min-w-0">
        <WorkflowCanvas />
      </div>

      <div className="w-[400px] flex flex-col h-full bg-white border-l border-slate-100 shrink-0">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-100 shrink-0 flex items-center justify-between">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-indigo-400">Handoff Mapping</p>
            <p className="text-sm font-semibold text-slate-700 truncate">{coreTask}</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={exportJSON} className="text-[11px] text-slate-400 hover:text-slate-600 px-2 py-1 rounded hover:bg-slate-50 transition">
              Export ↓
            </button>
            <button
              onClick={() => setPhase('complete')}
              className="text-[11px] bg-slate-800 hover:bg-slate-900 text-white px-3 py-1.5 rounded-lg transition"
            >
              Done
            </button>
          </div>
        </div>

        {/* Conversation */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-5 min-h-0 space-y-5">
          {isLoading && handoffMessages.length === 0 && (
            <div className="flex gap-2 items-center">
              {[0, 150, 300].map(d => <span key={d} className="w-2 h-2 bg-indigo-200 rounded-full animate-bounce" style={{ animationDelay: `${d}ms` }} />)}
            </div>
          )}
          {currentQuestion && (
            <p className="text-xl font-light text-slate-800 leading-relaxed">{currentQuestion}</p>
          )}
          {isLoading && currentQuestion && (
            <div className="flex gap-1.5">
              {[0, 150, 300].map(d => <span key={d} className="w-1.5 h-1.5 bg-slate-300 rounded-full animate-bounce" style={{ animationDelay: `${d}ms` }} />)}
            </div>
          )}

          {hasSuggestions && !showTextInput && (
            <div className="space-y-2">
              {suggestions!.items.map((s, i) => {
                const sel = selectedCards.has(i);
                return (
                  <button
                    key={i}
                    onClick={() => setSelectedCards(prev => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; })}
                    disabled={isLoading}
                    className={`flex items-center gap-3 w-full px-3.5 py-3 rounded-xl border text-left text-sm transition-all
                      ${sel ? 'border-indigo-400 bg-indigo-50' : 'border-slate-200 hover:border-indigo-300 hover:bg-indigo-50/50 bg-white'}`}
                  >
                    <span className={`w-6 h-6 rounded-md flex items-center justify-center text-xs font-semibold border shrink-0 transition-all
                      ${sel ? 'bg-indigo-500 border-indigo-500 text-white' : 'border-slate-200 text-slate-400'}`}>
                      {sel ? '✓' : String.fromCharCode(65 + i)}
                    </span>
                    <span className="flex-1 text-slate-700">{s.label}</span>
                  </button>
                );
              })}
              {selectedCards.size > 0 && (
                <button onClick={confirmSelected} className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-xl transition">
                  Confirm →
                </button>
              )}
            </div>
          )}

          {hasSuggestions && !showTextInput && (
            <button onClick={() => { setShowTextInput(true); setTimeout(() => inputRef.current?.focus(), 50); }} className="text-xs text-slate-400 hover:text-indigo-500 transition">
              Type your own answer →
            </button>
          )}
        </div>

        {/* Input */}
        <div className="shrink-0 px-5 pb-5 pt-3 border-t border-slate-100">
          {(!hasSuggestions || showTextInput) && (
            <div className="flex gap-2">
              <input
                ref={inputRef}
                className="flex-1 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 bg-white"
                placeholder="Describe how this handoff works…"
                value={answer}
                onChange={e => setAnswer(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) send(answer);
                  if (e.key === 'Escape' && hasSuggestions) { setShowTextInput(false); setAnswer(''); }
                }}
                disabled={isLoading}
              />
              <button
                onClick={() => send(answer)}
                disabled={!answer.trim() || isLoading}
                className="w-9 h-9 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-30 text-white rounded-lg flex items-center justify-center transition shrink-0"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" />
                </svg>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
