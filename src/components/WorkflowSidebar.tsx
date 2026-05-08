import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useWorkflowStore } from '../store';
import { sendChatMessage, saveSession, transcribeAudio, SuggestionSet, Suggestion } from '../lib/api';

type RecordState = 'idle' | 'recording' | 'transcribing';

function OptionCard({ s, index, onSelect, disabled }: { s: Suggestion; index: number; onSelect: () => void; disabled: boolean }) {
  const letter = String.fromCharCode(65 + index);
  const isDecision = s.type === 'decision';
  return (
    <button
      onClick={onSelect}
      disabled={disabled}
      className={`
        group flex items-center gap-3 w-full px-3.5 py-3 rounded-xl border text-left
        transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.99]
        ${isDecision
          ? 'border-amber-200/70 hover:border-amber-300 hover:bg-amber-50/70 bg-white'
          : 'border-slate-200/70 hover:border-indigo-300 hover:bg-indigo-50/70 bg-white'}
      `}
    >
      <span className={`
        flex-shrink-0 w-6 h-6 rounded-md flex items-center justify-center text-xs font-semibold border
        transition-all duration-150
        ${isDecision
          ? 'border-amber-200 text-amber-500 group-hover:bg-amber-400 group-hover:border-amber-400 group-hover:text-white'
          : 'border-slate-200 text-slate-400 group-hover:bg-indigo-500 group-hover:border-indigo-500 group-hover:text-white'}
      `}>{letter}</span>
      <span className="text-sm text-slate-700 leading-snug flex-1">{s.label}</span>
      {isDecision && (
        <span className="text-[10px] font-semibold uppercase tracking-widest text-amber-500/80 shrink-0">branch</span>
      )}
    </button>
  );
}

function MicButton({ state, onToggle, disabled }: { state: RecordState; onToggle: () => void; disabled: boolean }) {
  const isRecording = state === 'recording';
  const isTranscribing = state === 'transcribing';
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled || isTranscribing}
      title={isRecording ? 'Stop recording' : 'Record answer'}
      className={`
        w-9 h-9 rounded-lg flex items-center justify-center border transition-all duration-150 shrink-0
        ${isRecording
          ? 'bg-red-50 border-red-300 text-red-500 animate-pulse'
          : isTranscribing
            ? 'bg-gray-50 border-gray-200 text-gray-400 cursor-not-allowed'
            : 'bg-white border-slate-200 text-slate-400 hover:border-indigo-300 hover:text-indigo-500'}
        disabled:opacity-40
      `}
    >
      {isTranscribing ? (
        <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
        </svg>
      ) : isRecording ? (
        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1.5" /></svg>
      ) : (
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
          <rect x="9" y="2" width="6" height="12" rx="3" fill="currentColor" />
          <path d="M5 10a7 7 0 0 0 14 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
          <line x1="12" y1="19" x2="12" y2="22" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <line x1="9" y1="22" x2="15" y2="22" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}

export function WorkflowSidebar() {
  const {
    sessionId, coreTask, messages, isLoading,
    addMessage, setLoading, applyGraphUpdates, nodes, getExportData,
    userProfile, selectedTasks,
  } = useWorkflowStore(useShallow(s => ({
    sessionId: s.sessionId,
    coreTask: s.coreTask,
    messages: s.messages,
    isLoading: s.isLoading,
    addMessage: s.addMessage,
    setLoading: s.setLoading,
    applyGraphUpdates: s.applyGraphUpdates,
    nodes: s.nodes,
    getExportData: s.getExportData,
    userProfile: s.userProfile,
    selectedTasks: s.selectedTasks,
  })));

  const [answer, setAnswer] = useState('');
  const [suggestions, setSuggestions] = useState<SuggestionSet | null>(null);
  const [showTextInput, setShowTextInput] = useState(false);
  const [recordState, setRecordState] = useState<RecordState>('idle');

  const inputRef = useRef<HTMLInputElement>(null);
  const hasKickedOff = useRef(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const KICKOFF_MESSAGE = `We're mapping the workflow for "${coreTask}". Ask the participant to walk you through this process from start to finish in their own words. Do not offer answer choices yet.`;

  const currentQuestion = [...messages].reverse().find(m => m.role === 'assistant')?.content ?? '';

  useEffect(() => {
    if (hasKickedOff.current) return;
    hasKickedOff.current = true;
    const kickoff = [{ id: '__kickoff__', role: 'user' as const, content: KICKOFF_MESSAGE, timestamp: 0 }];
    setLoading(true);
    sendChatMessage(kickoff, coreTask, [], true, userProfile, selectedTasks)
      .then(({ message, graphUpdates, suggestions: s }) => {
        addMessage('assistant', message);
        if (graphUpdates.length) applyGraphUpdates(graphUpdates);
        setSuggestions(s);
      })
      .catch(err => addMessage('assistant', `Error: ${err.message}`))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, isLoading, suggestions]);

  useEffect(() => {
    if (!isLoading && showTextInput) inputRef.current?.focus();
  }, [isLoading, showTextInput]);

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || isLoading) return;
    setAnswer('');
    setShowTextInput(false);
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
      const { message, graphUpdates, suggestions: s } = await sendChatMessage(
        allMessages, coreTask, nodeSnapshot, false, userProfile, selectedTasks
      );
      addMessage('assistant', message);
      if (graphUpdates.length) {
        applyGraphUpdates(graphUpdates);
        const st = useWorkflowStore.getState();
        saveSession(sessionId, coreTask, { nodes: st.nodes, edges: st.edges }, st.messages).catch(() => {});
      }
      setSuggestions(s);
    } catch (err: unknown) {
      addMessage('assistant', `Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  const toggleRecording = async () => {
    if (recordState === 'recording') { mediaRecorderRef.current?.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunksRef.current = [];
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
        .find(t => MediaRecorder.isTypeSupported(t)) ?? '';
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = e => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const chunks = audioChunksRef.current;
        if (chunks.length === 0) { setRecordState('idle'); return; }
        setRecordState('transcribing');
        try {
          const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
          const text = await transcribeAudio(blob);
          if (text.trim()) {
            setAnswer(prev => (prev ? prev + ' ' + text : text));
            setShowTextInput(true);
            setTimeout(() => inputRef.current?.focus(), 50);
          }
        } catch (e) { console.error('Transcription failed', e); }
        finally { setRecordState('idle'); }
      };
      recorder.start(250);
      setRecordState('recording');
    } catch (e) { console.error('Mic access denied', e); }
  };

  const hasSuggestions = !!(suggestions?.items.length && !isLoading);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!hasSuggestions || showTextInput) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const idx = e.key.toUpperCase().charCodeAt(0) - 65;
      if (idx >= 0 && idx < (suggestions?.items.length ?? 0)) send(suggestions!.items[idx].label);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [hasSuggestions, showTextInput, suggestions, isLoading]);

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

  return (
    <div className="w-[380px] flex flex-col h-full bg-white border-l border-slate-100 shrink-0">
      {/* Header */}
      <div className="px-5 py-4 border-b border-slate-100 shrink-0 flex items-center justify-between">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-indigo-400">Mapping</p>
          <p className="text-sm font-semibold text-slate-700 truncate">{coreTask}</p>
        </div>
        <button
          onClick={exportJSON}
          className="text-[11px] text-slate-400 hover:text-slate-600 transition ml-3 shrink-0 px-2 py-1 rounded-lg hover:bg-slate-50"
        >
          Export ↓
        </button>
      </div>

      {/* Scrollable: question + suggestions */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-5 min-h-0 space-y-5">
        {/* Current question */}
        <div>
          {isLoading && !currentQuestion ? (
            <div className="flex gap-2 items-center h-8">
              {[0, 150, 300].map(d => (
                <span key={d} className="w-2 h-2 bg-indigo-200 rounded-full animate-bounce" style={{ animationDelay: `${d}ms` }} />
              ))}
            </div>
          ) : (
            <p className="text-xl font-light text-slate-800 leading-relaxed tracking-tight">{currentQuestion}</p>
          )}
          {isLoading && currentQuestion && (
            <div className="flex gap-1.5 mt-3">
              {[0, 150, 300].map(d => (
                <span key={d} className="w-1.5 h-1.5 bg-slate-300 rounded-full animate-bounce" style={{ animationDelay: `${d}ms` }} />
              ))}
            </div>
          )}
        </div>

        {/* Suggestion cards */}
        {hasSuggestions && !showTextInput && (
          <div className="space-y-2">
            {suggestions!.prompt && (
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">{suggestions!.prompt}</p>
            )}
            {suggestions!.items.map((s, i) => (
              <OptionCard key={i} s={s} index={i} onSelect={() => send(s.label)} disabled={isLoading} />
            ))}
          </div>
        )}

        {hasSuggestions && !showTextInput && (
          <button
            onClick={() => { setShowTextInput(true); setTimeout(() => inputRef.current?.focus(), 50); }}
            className="text-xs text-slate-400 hover:text-indigo-500 transition"
          >
            Type your own answer →
          </button>
        )}
      </div>

      {/* Input area */}
      <div className="shrink-0 px-5 pb-5 pt-3 border-t border-slate-100">
        {(!hasSuggestions || showTextInput) && (
          <div className="space-y-2">
            <div className="flex gap-2 items-center">
              <input
                ref={inputRef}
                className="flex-1 border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-800
                           placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-300
                           focus:border-transparent bg-white transition-all"
                placeholder={hasSuggestions ? 'Or describe something else…' : 'Type your answer…'}
                value={answer}
                onChange={e => setAnswer(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) send(answer);
                  if (e.key === 'Escape' && hasSuggestions) { setShowTextInput(false); setAnswer(''); }
                }}
                disabled={isLoading || recordState !== 'idle'}
              />
              <MicButton state={recordState} onToggle={toggleRecording} disabled={isLoading} />
              <button
                onClick={() => send(answer)}
                disabled={!answer.trim() || isLoading}
                className="w-9 h-9 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-30 text-white
                           rounded-lg flex items-center justify-center transition-all active:scale-95 shrink-0"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" />
                </svg>
              </button>
            </div>
            {hasSuggestions && (
              <p className="text-[11px] text-slate-400">
                <kbd className="bg-slate-100 px-1.5 py-0.5 rounded text-[10px] font-mono text-slate-500 mr-1">Esc</kbd>
                back to options
              </p>
            )}
          </div>
        )}

        {hasSuggestions && !showTextInput && (
          <div className="flex items-center gap-2.5">
            <MicButton state={recordState} onToggle={toggleRecording} disabled={isLoading} />
            <p className="text-[11px] text-slate-400">Press A–D to select · or record</p>
          </div>
        )}
      </div>
    </div>
  );
}
