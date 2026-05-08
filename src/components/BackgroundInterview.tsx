import { useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useWorkflowStore } from '../store';
import { evaluateAnswer, transcribeAudio } from '../lib/api';
import { UserProfile } from '../types';

type RecordState = 'idle' | 'recording' | 'transcribing';

// Coverage criteria and follow-up rules per question, taken from SparkMe topics_intake.json
const QUESTIONS: {
  field: keyof UserProfile;
  text: string;
  placeholder: string;
  criteria: string[];
  maxFollowups: number;
}[] = [
  {
    field: 'jobTitle',
    text: 'What is your job title and what does your company do?',
    placeholder: 'e.g. Software Engineer at a fintech startup, Product Manager at a healthcare company…',
    criteria: [
      "The participant has named their job title or role (e.g. 'nurse', 'software engineer', 'product manager'). Any brief mention is sufficient.",
      "It is clear what field or industry the participant works in.",
      "There is some indication of what the company does or what kind of product/service it offers.",
    ],
    maxFollowups: 1,
  },
  {
    field: 'tenure',
    text: 'How long have you been in this role?',
    placeholder: 'e.g. 2 years, just started, about 6 months…',
    criteria: [
      "The participant has indicated approximately how long they have been in this specific role. Any rough range is sufficient ('a few years', '6 months', 'just started'). Accept any answer as-is — do NOT follow up on duration.",
    ],
    maxFollowups: 0, // SparkMe rule: never follow up on tenure
  },
  {
    field: 'typicalWeek',
    text: 'Walk me through what a typical week looks like for you.',
    placeholder: 'Describe your regular activities, meetings, deliverables…',
    criteria: [
      "The participant has described at least a few of the regular activities or tasks they do most weeks. A general overview is sufficient.",
      "The participant has mentioned at least one concrete type of task or activity (e.g. a meeting, a recurring deliverable, a tool they use, a person they coordinate with).",
    ],
    maxFollowups: 1,
  },
];

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
          className={`relative z-10 w-20 h-20 rounded-full flex items-center justify-center transition-all duration-200
            ${isRecording ? 'bg-red-500 shadow-lg shadow-red-200 scale-105'
              : isTranscribing ? 'bg-indigo-100 cursor-not-allowed'
              : 'bg-indigo-50 hover:bg-indigo-100 hover:scale-105 active:scale-95 shadow-sm'}
            disabled:opacity-50`}
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

export function BackgroundInterview() {
  const { setUserProfile, setPhase } = useWorkflowStore(useShallow(s => ({
    setUserProfile: s.setUserProfile,
    setPhase: s.setPhase,
  })));

  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<keyof UserProfile, string>>({
    jobTitle: '', tenure: '', typicalWeek: '',
  });

  // Follow-up state for current question
  const [followUpQ, setFollowUpQ] = useState<string | null>(null);
  const [followUpCount, setFollowUpCount] = useState(0);
  const [accumulatedAnswer, setAccumulatedAnswer] = useState('');

  const [input, setInput] = useState('');
  const [showTextInput, setShowTextInput] = useState(false);
  const [recordState, setRecordState] = useState<RecordState>('idle');
  const [recordTranscribeError, setRecordTranscribeError] = useState<string | null>(null);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [questionVisible, setQuestionVisible] = useState(true);

  const inputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  const q = QUESTIONS[step];
  // What's visually shown as the current question text
  const displayQuestion = followUpQ ?? q.text;
  const isFollowUpActive = followUpQ !== null;

  const advanceStep = async (finalAnswer: string) => {
    const newAnswers = { ...answers, [q.field]: finalAnswer };
    setAnswers(newAnswers);
    setFollowUpQ(null);
    setFollowUpCount(0);
    setAccumulatedAnswer('');
    setInput('');
    setShowTextInput(false);

    if (step < QUESTIONS.length - 1) {
      setQuestionVisible(false);
      setTimeout(() => { setStep(s => s + 1); setQuestionVisible(true); }, 220);
    } else {
      setIsSubmitting(true);
      const profile = newAnswers as UserProfile;
      setUserProfile(profile);
      setPhase('task-selection');
    }
  };

  const advance = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || isEvaluating) return;

    setInput('');
    setShowTextInput(false);

    // Build up the full answer context for coverage evaluation
    const combined = isFollowUpActive
      ? `${accumulatedAnswer}\n${trimmed}`
      : trimmed;

    const newFollowUpCount = isFollowUpActive ? followUpCount + 1 : followUpCount;

    // If this question has follow-up capacity remaining, evaluate coverage
    if (newFollowUpCount < q.maxFollowups) {
      setIsEvaluating(true);
      try {
        const result = await evaluateAnswer(
          q.text,
          combined,
          q.criteria,
          q.maxFollowups,
          newFollowUpCount
        );
        if (!result.allCovered && result.followUp) {
          // Show follow-up question
          setAccumulatedAnswer(combined);
          setFollowUpCount(newFollowUpCount);
          setFollowUpQ(result.followUp);
          setQuestionVisible(false);
          setTimeout(() => setQuestionVisible(true), 180);
          setIsEvaluating(false);
          return;
        }
      } catch (e) {
        console.error('Coverage evaluation failed', e);
      } finally {
        setIsEvaluating(false);
      }
    }

    // All covered (or max follow-ups reached, or evaluation failed) — advance
    await advanceStep(combined);
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
        if (chunks.length === 0) {
          setRecordTranscribeError('No audio captured — try again.');
          setRecordState('idle');
          return;
        }
        setRecordState('transcribing');
        try {
          const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
          const text = await transcribeAudio(blob);
          if (text.trim()) {
            setInput(prev => (prev ? prev + ' ' + text : text));
            setShowTextInput(true);
            setTimeout(() => inputRef.current?.focus(), 50);
          } else {
            setRecordTranscribeError('Nothing was heard — try again.');
          }
        } catch (e) {
          console.error('Transcription failed', e);
          setRecordTranscribeError('Transcription failed — try again or type your answer.');
        } finally {
          setRecordState('idle');
        }
      };
      recorder.start(250); // 250ms timeslice ensures data flows reliably
      setRecordTranscribeError(null);
      setRecordState('recording');
    } catch (e) {
      console.error('Mic access denied', e);
      setRecordTranscribeError('Microphone access denied — please allow mic permissions.');
    }
  };

  if (isSubmitting) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-white gap-4">
        <div className="flex gap-2">
          {[0, 150, 300].map(d => (
            <span key={d} className="w-2.5 h-2.5 bg-indigo-300 rounded-full animate-bounce" style={{ animationDelay: `${d}ms` }} />
          ))}
        </div>
        <p className="text-sm text-slate-500">Building your task list…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-white relative overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-56 bg-gradient-to-b from-indigo-50/30 to-transparent pointer-events-none" />

      {/* Header with step progress */}
      <div className="relative z-10 px-10 pt-8 pb-5 shrink-0">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-indigo-400 mb-4">Part 1 of 3 — Background</p>
        <div className="flex gap-2 items-center">
          {QUESTIONS.map((_, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className={`flex items-center justify-center w-6 h-6 rounded-full text-[11px] font-semibold transition-all duration-300 ${
                i < step
                  ? 'bg-indigo-500 text-white'
                  : i === step
                    ? 'bg-indigo-100 text-indigo-600 ring-2 ring-indigo-400 ring-offset-1'
                    : 'bg-slate-100 text-slate-400'
              }`}>
                {i < step ? (
                  <svg className="w-3 h-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="2 6 5 9 10 3" />
                  </svg>
                ) : i + 1}
              </div>
              {i < QUESTIONS.length - 1 && (
                <div className="w-8 h-[2px] rounded-full overflow-hidden bg-slate-100">
                  <div className={`h-full bg-indigo-400 transition-all duration-500 ${i < step ? 'w-full' : 'w-0'}`} />
                </div>
              )}
            </div>
          ))}
          <span className="ml-2 text-xs text-slate-400">
            Question {step + 1} of {QUESTIONS.length}
            {isFollowUpActive && <span className="ml-1.5 text-indigo-400">· follow-up</span>}
          </span>
        </div>
      </div>

      {/* Main content */}
      <div className="relative z-10 flex-1 flex flex-col justify-center min-h-0 overflow-y-auto">
        <div className="px-10 max-w-2xl mx-auto w-full">

          {/* Question / follow-up */}
          <div
            className="mb-12 transition-all duration-250"
            style={{ opacity: questionVisible ? 1 : 0, transform: questionVisible ? 'translateY(0)' : 'translateY(10px)' }}
          >
            {isFollowUpActive && (
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-indigo-400 mb-3 flex items-center gap-1.5">
                <svg className="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M2 4h8a4 4 0 0 1 0 8H6" />
                  <polyline points="3 11 6 14 3 17" transform="scale(1,0.7) translate(0,4)" />
                </svg>
                Follow-up
              </p>
            )}
            <p className="text-[1.75rem] font-light text-slate-800 leading-[1.45] tracking-[-0.015em]">
              {displayQuestion}
            </p>
          </div>

          {/* Evaluating indicator */}
          {isEvaluating && (
            <div className="flex items-center gap-2 mb-8 text-sm text-slate-400">
              <div className="flex gap-1">
                {[0, 150, 300].map(d => (
                  <span key={d} className="w-1.5 h-1.5 bg-indigo-300 rounded-full animate-bounce" style={{ animationDelay: `${d}ms` }} />
                ))}
              </div>
            </div>
          )}

          {/* Mic orb */}
          {!showTextInput && !isEvaluating && (
            <div className="flex flex-col items-center py-4 mb-8 gap-3">
              <MicOrb state={recordState} onToggle={toggleRecording} disabled={isEvaluating} />
              {recordTranscribeError && (
                <p className="text-xs text-red-500 text-center">{recordTranscribeError}</p>
              )}
            </div>
          )}

          {/* Text input */}
          {showTextInput && !isEvaluating && (
            <div className="space-y-3 mb-8">
              <div className="flex gap-2 items-center">
                <input
                  ref={inputRef}
                  className="flex-1 border border-slate-200 rounded-2xl px-5 py-3.5 text-sm text-slate-800
                             placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-300
                             focus:border-transparent bg-white transition-all duration-150"
                  placeholder={isFollowUpActive ? 'Your answer…' : q.placeholder}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) advance(input); }}
                  disabled={recordState !== 'idle' || isEvaluating}
                  autoFocus
                />
                <button
                  onClick={() => advance(input)}
                  disabled={!input.trim() || recordState !== 'idle' || isEvaluating}
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
                to continue
              </p>
            </div>
          )}

          {/* Type / mic toggle */}
          {!showTextInput && !isEvaluating && (
            <div className="text-center">
              <button
                onClick={() => { setShowTextInput(true); setTimeout(() => inputRef.current?.focus(), 50); }}
                className="text-xs text-slate-400 hover:text-indigo-500 transition"
              >
                Prefer to type? →
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="h-10 shrink-0" />
    </div>
  );
}
