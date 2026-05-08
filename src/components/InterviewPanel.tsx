import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useWorkflowStore } from '../store';
import { sendChatMessage, saveSession, SuggestionSet, Suggestion } from '../lib/api';

const TYPE_STYLES: Record<string, { bar: string; text: string; bg: string; hover: string }> = {
  task:     { bar: 'bg-blue-400',   text: 'text-blue-700',   bg: 'bg-blue-50',   hover: 'hover:bg-blue-100 hover:border-blue-300' },
  decision: { bar: 'bg-orange-400', text: 'text-orange-700', bg: 'bg-orange-50', hover: 'hover:bg-orange-100 hover:border-orange-300' },
};

const KICKOFF_MESSAGE = "Let's begin. Please greet me and ask an open question inviting me to walk through my workflow from start to finish in my own words. Do not offer answer choices yet.";

function SuggestionCard({ s, onSelect, disabled }: { s: Suggestion; onSelect: () => void; disabled: boolean }) {
  const st = TYPE_STYLES[s.type] ?? TYPE_STYLES.task;
  return (
    <button
      onClick={onSelect}
      disabled={disabled}
      className={`
        w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border border-gray-200
        text-left text-sm font-medium text-gray-700 bg-white
        transition-all duration-100 disabled:opacity-40 disabled:cursor-not-allowed
        ${st.hover} active:scale-[0.98]
      `}
    >
      <span className={`w-1 self-stretch rounded-full shrink-0 ${st.bar}`} />
      <span className="flex-1 leading-snug">{s.label}</span>
      <span className={`text-[10px] font-semibold uppercase tracking-wide ${st.text} shrink-0`}>{s.type}</span>
    </button>
  );
}

export function InterviewPanel() {
  const { sessionId, coreTask, messages, isLoading, addMessage, setLoading, applyGraphUpdates, nodes, getExportData } =
    useWorkflowStore(useShallow(s => ({
      sessionId: s.sessionId,
      coreTask: s.coreTask,
      messages: s.messages,
      isLoading: s.isLoading,
      addMessage: s.addMessage,
      setLoading: s.setLoading,
      applyGraphUpdates: s.applyGraphUpdates,
      nodes: s.nodes,
      getExportData: s.getExportData,
    })));

  const [input, setInput] = useState('');
  const [showInput, setShowInput] = useState(false);
  const [suggestions, setSuggestions] = useState<SuggestionSet | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const hasKickedOff = useRef(false);

  useEffect(() => {
    if (hasKickedOff.current) return;
    hasKickedOff.current = true;

    const kickoff = [{ id: '__kickoff__', role: 'user' as const, content: KICKOFF_MESSAGE, timestamp: 0 }];
    setLoading(true);
    sendChatMessage(kickoff, coreTask, [], true)
      .then(({ message, graphUpdates, suggestions: s }) => {
        addMessage('assistant', message);
        if (graphUpdates.length) applyGraphUpdates(graphUpdates);
        setSuggestions(s);
      })
      .catch(err => addMessage('assistant', `Sorry, something went wrong: ${err.message}`))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading, suggestions]);

  useEffect(() => {
    if (showInput) inputRef.current?.focus();
  }, [showInput]);

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || isLoading) return;
    setInput('');
    setShowInput(false);
    setSuggestions(null);
    addMessage('user', content);
    setLoading(true);

    try {
      const allMessages = [
        { id: '__kickoff__', role: 'user' as const, content: KICKOFF_MESSAGE, timestamp: 0 },
        ...useWorkflowStore.getState().messages,
        { id: '__new__', role: 'user' as const, content, timestamp: Date.now() },
      ];
      const nodeSnapshot = nodes.map(n => ({ id: n.id, type: n.type as string, label: n.data.label }));
      const { message, graphUpdates, suggestions: s } = await sendChatMessage(allMessages, coreTask, nodeSnapshot);
      addMessage('assistant', message);
      if (graphUpdates.length) {
        applyGraphUpdates(graphUpdates);
        const state = useWorkflowStore.getState();
        saveSession(sessionId, coreTask, { nodes: state.nodes, edges: state.edges }, state.messages).catch(() => {});
      }
      setSuggestions(s);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addMessage('assistant', `Sorry, something went wrong: ${msg}`);
    } finally {
      setLoading(false);
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

  const hasSuggestions = suggestions && suggestions.items.length > 0 && !isLoading;

  return (
    <div className="w-[380px] flex flex-col h-full border-r border-gray-200 bg-white">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between shrink-0">
        <div>
          <p className="text-xs text-gray-400 uppercase tracking-wide">Mapping</p>
          <p className="text-sm font-semibold text-gray-800 truncate max-w-[260px]">{coreTask}</p>
        </div>
        <button
          onClick={exportJSON}
          className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 px-3 py-1.5 rounded-lg transition"
        >
          Export JSON
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 min-h-0">
        {messages.map(m => (
          <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                m.role === 'user'
                  ? 'bg-blue-600 text-white rounded-br-sm'
                  : 'bg-gray-100 text-gray-800 rounded-bl-sm'
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-gray-100 rounded-2xl rounded-bl-sm px-4 py-2.5">
              <div className="flex gap-1 items-center h-4">
                <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:0ms]" />
                <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:150ms]" />
                <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Response area */}
      <div className="px-4 pb-4 pt-2 shrink-0 space-y-2 border-t border-gray-100">
        {/* Suggestion cards */}
        {hasSuggestions && (
          <div className="space-y-1.5">
            {suggestions!.items.map((s, i) => (
              <SuggestionCard
                key={i}
                s={s}
                onSelect={() => send(s.label)}
                disabled={isLoading}
              />
            ))}
          </div>
        )}

        {/* "Describe something else" toggle + input */}
        {hasSuggestions && !showInput && (
          <button
            onClick={() => setShowInput(true)}
            className="w-full text-xs text-gray-400 hover:text-gray-600 text-center py-1.5 transition"
          >
            + Describe something else
          </button>
        )}

        {/* Free-text input — shown when no suggestions, or user clicked "describe something else" */}
        {(!hasSuggestions || showInput) && (
          <div className="flex gap-2">
            <input
              ref={inputRef}
              className="flex-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
              placeholder={hasSuggestions ? 'Describe something else…' : 'Type your response…'}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) send(input);
                if (e.key === 'Escape' && hasSuggestions) { setShowInput(false); setInput(''); }
              }}
              disabled={isLoading}
            />
            <button
              onClick={() => send(input)}
              disabled={!input.trim() || isLoading}
              className="bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white px-4 rounded-xl transition"
            >
              ↑
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
