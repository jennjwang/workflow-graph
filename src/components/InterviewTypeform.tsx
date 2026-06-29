import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useWorkflowStore } from '../store';
import { sendChatMessage, saveSession, transcribeAudio, SuggestionSet, Suggestion } from '../lib/api';

const KICKOFF_MESSAGE =
  "Let's begin the workflow mapping phase. Please greet me by referencing my role, briefly acknowledge the tasks I've selected, and ask which task I'd like to map first. Do not offer answer choices yet.";

type RecordState = 'idle' | 'recording' | 'transcribing';

/** Large centered mic orb — used when the mic is the primary CTA */
function MicOrb({ state, onToggle, disabled }: { state: RecordState; onToggle: () => void; disabled: boolean }) {
  const isRecording = state === 'recording';
  const isTranscribing = state === 'transcribing';
  return (
    <div className="flex flex-col items-center gap-3 select-none">
      <div className="relative flex items-center justify-center">
        {isRecording && (
          <>
            <span className="absolute w-36 h-36 rounded-full bg-indigo-100 animate-ping opacity-30" />
            <span className="absolute w-28 h-28 rounded-full bg-indigo-100 animate-ping opacity-50 [animation-delay:250ms]" />
          </>
        )}
        <button
          type="button"
          onClick={onToggle}
          disabled={disabled || isTranscribing}
          className={`
            relative z-10 w-20 h-20 rounded-full flex items-center justify-center
            transition-all duration-200
            ${isRecording
              ? 'bg-red-500 shadow-lg shadow-red-200 scale-105'
              : isTranscribing
                ? 'bg-indigo-100 cursor-not-allowed'
                : 'bg-indigo-50 hover:bg-indigo-100 hover:scale-105 active:scale-95 shadow-sm'}
            disabled:opacity-50
          `}
        >
          {isTranscribing ? (
            <svg className="w-7 h-7 text-indigo-400 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
            </svg>
          ) : isRecording ? (
            <svg className="w-6 h-6 text-white" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          ) : (
            <svg className="w-8 h-8 text-indigo-600" viewBox="0 0 24 24" fill="none">
              <rect x="9" y="2" width="6" height="12" rx="3" fill="currentColor" />
              <path d="M5 10a7 7 0 0 0 14 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
              <line x1="12" y1="19" x2="12" y2="22" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              <line x1="9" y1="22" x2="15" y2="22" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          )}
        </button>
      </div>
      <span className={`text-sm font-medium tracking-wide transition-colors ${
        isRecording ? 'text-red-500' : isTranscribing ? 'text-indigo-400' : 'text-indigo-600'
      }`}>
        {isRecording ? 'Recording — click to stop' : isTranscribing ? 'Transcribing…' : 'Start Recording'}
      </span>
    </div>
  );
}

/** Small inline mic icon — used alongside the text input */
function MicInline({ state, onToggle, disabled }: { state: RecordState; onToggle: () => void; disabled: boolean }) {
  const isRecording = state === 'recording';
  const isTranscribing = state === 'transcribing';
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled || isTranscribing}
      title={isRecording ? 'Stop recording' : 'Record answer'}
      className={`
        w-10 h-10 rounded-xl flex items-center justify-center border transition-all duration-150 shrink-0
        ${isRecording
          ? 'bg-red-50 border-red-300 text-red-500 animate-pulse'
          : isTranscribing
            ? 'bg-gray-50 border-gray-200 text-gray-400 cursor-not-allowed'
            : 'bg-white border-slate-200 text-slate-500 hover:border-indigo-300 hover:text-indigo-500'}
        disabled:opacity-40
      `}
    >
      {isTranscribing ? (
        <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
        </svg>
      ) : isRecording ? (
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1.5" /></svg>
      ) : (
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none">
          <rect x="9" y="2" width="6" height="12" rx="3" fill="currentColor" />
          <path d="M5 10a7 7 0 0 0 14 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
          <line x1="12" y1="19" x2="12" y2="22" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <line x1="9" y1="22" x2="15" y2="22" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}

function OptionCard({ s, index, onSelect, disabled }: { s: Suggestion; index: number; onSelect: () => void; disabled: boolean }) {
  const letter = String.fromCharCode(65 + index);
  const isDecision = s.type === 'decision';
  return (
    <button
      onClick={onSelect}
      disabled={disabled}
      className={`
        group flex items-center gap-3.5 w-full px-4 py-3.5 rounded-2xl border text-left
        transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.99]
        ${isDecision
          ? 'border-amber-200/70 hover:border-amber-300 hover:bg-amber-50/70 bg-white'
          : 'border-slate-200/70 hover:border-indigo-300 hover:bg-indigo-50/70 bg-white'}
      `}
    >
      <span className={`
        flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-xs font-semibold border
        transition-all duration-150
        ${isDecision
          ? 'border-amber-200 text-amber-500 group-hover:bg-amber-400 group-hover:border-amber-400 group-hover:text-white'
          : 'border-slate-200 text-slate-400 group-hover:bg-indigo-500 group-hover:border-indigo-500 group-hover:text-white'}
      `}>{letter}</span>
      <span className="text-sm font-medium text-slate-700 leading-snug flex-1">{s.label}</span>
      {isDecision && (
        <span className="text-[10px] font-semibold uppercase tracking-widest text-amber-500/80 shrink-0">branch</span>
      )}
    </button>
  );
}

interface Props {
  onShowMap: () => void;
  mapVisible: boolean;
}

export function InterviewTypeform({ onShowMap, mapVisible }: Props) {
  const {
    sessionId, coreTask, messages, isLoading,
    addMessage, setLoading, applyGraphUpdates, nodes, getExportData,
    selectedTasks,
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
    selectedTasks: s.selectedTasks,
  })));

  const [answer, setAnswer] = useState('');
  const [suggestions, setSuggestions] = useState<SuggestionSet | null>(null);
  const [showTextInput, setShowTextInput] = useState(false);
  const [recordState, setRecordState] = useState<RecordState>('idle');
  const [questionCount, setQuestionCount] = useState(0);
  const [questionVisible, setQuestionVisible] = useState(true);

  const inputRef = useRef<HTMLInputElement>(null);
  const hasKickedOff = useRef(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const prevQuestion = useRef('');

  const currentQuestion = [...messages].reverse().find(m => m.role === 'assistant')?.content ?? '';

  useEffect(() => {
    if (currentQuestion && currentQuestion !== prevQuestion.current) {
      setQuestionVisible(false);
      const t = setTimeout(() => { prevQuestion.current = currentQuestion; setQuestionVisible(true); }, 200);
      return () => clearTimeout(t);
    }
  }, [currentQuestion]);

  useEffect(() => {
    if (hasKickedOff.current) return;
    hasKickedOff.current = true;
    const kickoff = [{ id: '__kickoff__', role: 'user' as const, content: KICKOFF_MESSAGE, timestamp: 0 }];
    setLoading(true);
    sendChatMessage(kickoff, coreTask, [], true, selectedTasks)
      .then(({ message, graphUpdates, suggestions: s }) => {
        addMessage('assistant', message);
        if (graphUpdates.length) applyGraphUpdates(graphUpdates);
        setSuggestions(s);
        setQuestionCount(q => q + 1);
      })
      .catch(err => addMessage('assistant', `Error: ${err.message}`))
      .finally(() => setLoading(false));
  }, []);

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
      const { message, graphUpdates, suggestions: s } = await sendChatMessage(allMessages, coreTask, nodeSnapshot, false, selectedTasks);
      addMessage('assistant', message);
      if (graphUpdates.length) {
        applyGraphUpdates(graphUpdates);
        const st = useWorkflowStore.getState();
        saveSession(sessionId, coreTask, { nodes: st.nodes, edges: st.edges }, st.messages).catch(() => {});
      }
      setSuggestions(s);
      setQuestionCount(q => q + 1);
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
    const a = document.createElement('a'); a.href = url;
    a.download = `workflow-${sessionId.slice(0, 8)}.json`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={`flex flex-col h-full bg-white transition-all duration-300 ${mapVisible ? 'w-[460px] border-r border-slate-100' : 'w-full'}`}>
      {/* Top accent */}
      <div className="absolute top-0 left-0 right-0 h-56 bg-gradient-to-b from-indigo-50/30 to-transparent pointer-events-none" />

      {/* Header */}
      <div className="relative z-10 px-10 pt-8 pb-5 flex items-start justify-between shrink-0">
        <div className="flex-1 min-w-0 mr-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-indigo-400 mb-3">Part 3 of 3 — Workflow Mapping</p>
          {/* Conversation progress bar */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-500">
                {questionCount === 0 ? 'Starting…' : `${questionCount} exchange${questionCount !== 1 ? 's' : ''}`}
              </span>
              <span className="text-xs text-slate-400">{Math.min(questionCount * 8, 92)}%</span>
            </div>
            <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-indigo-400 to-violet-400 rounded-full transition-all duration-700 ease-out"
                style={{ width: `${Math.min(questionCount * 8, 92)}%` }}
              />
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 mt-0.5">
          {nodes.length > 0 && (
            <button
              onClick={onShowMap}
              className="text-[11px] font-medium text-indigo-500 hover:text-indigo-700 transition flex items-center gap-1"
            >
              {mapVisible ? '← Hide map' : 'View map →'}
            </button>
          )}
          <button onClick={exportJSON} className="text-[11px] text-slate-400 hover:text-slate-600 transition px-2 py-1 rounded-lg hover:bg-slate-50">
            Export ↓
          </button>
        </div>
      </div>

      {/* Main — question + answers */}
      <div className="relative z-10 flex-1 flex flex-col justify-center min-h-0 overflow-y-auto">
        <div className={`px-10 transition-all duration-250 ${mapVisible ? '' : 'max-w-2xl mx-auto w-full'}`}>

          {/* Question text */}
          <div
            className="mb-12 transition-all duration-300"
            style={{ opacity: questionVisible ? 1 : 0, transform: questionVisible ? 'translateY(0)' : 'translateY(10px)' }}
          >
            {isLoading && !currentQuestion ? (
              <div className="flex gap-2 h-10 items-center">
                {[0, 150, 300].map(d => (
                  <span key={d} className="w-2.5 h-2.5 bg-indigo-200 rounded-full animate-bounce" style={{ animationDelay: `${d}ms` }} />
                ))}
              </div>
            ) : (
              <p className="text-[1.75rem] font-light text-slate-800 leading-[1.45] tracking-[-0.015em]">
                {currentQuestion}
              </p>
            )}
            {isLoading && currentQuestion && (
              <div className="flex gap-1.5 mt-5">
                {[0, 150, 300].map(d => (
                  <span key={d} className="w-1.5 h-1.5 bg-slate-300 rounded-full animate-bounce" style={{ animationDelay: `${d}ms` }} />
                ))}
              </div>
            )}
          </div>

          {/* Suggestion cards */}
          {hasSuggestions && !showTextInput && (
            <div className="space-y-2.5 mb-8">
              {suggestions!.prompt && (
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400 mb-2">{suggestions!.prompt}</p>
              )}
              {suggestions!.items.map((s, i) => (
                <OptionCard key={i} s={s} index={i} onSelect={() => send(s.label)} disabled={isLoading} />
              ))}
            </div>
          )}

          {/* Big mic — only when no suggestions & no text input */}
          {!hasSuggestions && !showTextInput && !isLoading && (
            <div className="flex justify-center py-4 mb-8">
              <MicOrb state={recordState} onToggle={toggleRecording} disabled={isLoading} />
            </div>
          )}

          {/* Text input (after recording or "type instead") */}
          {showTextInput && (
            <div className="space-y-3 mb-8">
              <div className="flex gap-2 items-center">
                <input
                  ref={inputRef}
                  className="flex-1 border border-slate-200 rounded-2xl px-5 py-3.5 text-sm text-slate-800
                             placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-300
                             focus:border-transparent bg-white transition-all duration-150"
                  placeholder={hasSuggestions ? 'Or describe something else…' : 'Type your answer…'}
                  value={answer}
                  onChange={e => setAnswer(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) send(answer);
                    if (e.key === 'Escape' && hasSuggestions) { setShowTextInput(false); setAnswer(''); }
                  }}
                  disabled={isLoading || recordState !== 'idle'}
                />
                <MicInline state={recordState} onToggle={toggleRecording} disabled={isLoading} />
                <button
                  onClick={() => send(answer)}
                  disabled={!answer.trim() || isLoading}
                  className="w-10 h-10 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-30 text-white
                             rounded-xl flex items-center justify-center transition-all active:scale-95
                             shadow-sm shadow-indigo-200 shrink-0"
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" />
                  </svg>
                </button>
              </div>
              <p className="text-[11px] text-slate-400 pl-1">
                <kbd className="bg-slate-100 px-1.5 py-0.5 rounded text-[10px] font-mono text-slate-500 mr-1">Enter</kbd>
                to submit
                {hasSuggestions && (
                  <span className="ml-3 text-slate-400">
                    <kbd className="bg-slate-100 px-1.5 py-0.5 rounded text-[10px] font-mono text-slate-500 mr-1">Esc</kbd>
                    back to options
                  </span>
                )}
              </p>
            </div>
          )}

          {/* Bottom links */}
          {!showTextInput && (
            <div className="flex items-center justify-between">
              {hasSuggestions ? (
                <>
                  <MicInline state={recordState} onToggle={toggleRecording} disabled={isLoading} />
                  <button
                    onClick={() => { setShowTextInput(true); setTimeout(() => inputRef.current?.focus(), 50); }}
                    className="text-xs text-slate-400 hover:text-indigo-500 transition"
                  >
                    Type your own answer →
                  </button>
                </>
              ) : !isLoading ? (
                <button
                  onClick={() => { setShowTextInput(true); setTimeout(() => inputRef.current?.focus(), 50); }}
                  className="text-xs text-slate-400 hover:text-indigo-500 transition mx-auto"
                >
                  Prefer to type? →
                </button>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {/* Subtle bottom spacer */}
      <div className="h-10 shrink-0" />
    </div>
  );
}
