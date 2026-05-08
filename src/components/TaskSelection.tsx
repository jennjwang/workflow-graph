import { useCallback, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { generateTaskBatch } from '../lib/api';
import { useWorkflowStore } from '../store';
import { TaskItem, TaskRecency, TaskStatus } from '../types';

const PAGE_SIZE = 3;
const BUFFER_PAGES = 2;

export function TaskSelection() {
  const { userProfile, setSelectedTasks, setPhase } = useWorkflowStore(
    useShallow(s => ({
      userProfile: s.userProfile,
      setSelectedTasks: s.setSelectedTasks,
      setPhase: s.setPhase,
    }))
  );

  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [isFetching, setIsFetching] = useState(false);
  const [editBonusCount, setEditBonusCount] = useState(0);
  const [showBonusToast, setShowBonusToast] = useState(false);
  const [customInput, setCustomInput] = useState('');
  const [showCustom, setShowCustom] = useState(false);
  const customRef = useRef<HTMLInputElement>(null);
  const batchIndexRef = useRef(0);
  const fetchingRef = useRef(false);
  const bonusToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchBatch = useCallback(async (currentTasks: TaskItem[]) => {
    if (fetchingRef.current || !hasMore) return;
    fetchingRef.current = true;
    setIsFetching(true);
    try {
      const priorNames = currentTasks.map(t => t.originalName);
      const result = await generateTaskBatch(
        userProfile.jobTitle,
        userProfile.tenure,
        userProfile.typicalWeek,
        batchIndexRef.current,
        priorNames
      );
      batchIndexRef.current += 1;
      const newItems: TaskItem[] = (result.tasks ?? []).map(t => ({
        name: t.name,
        originalName: t.name,
        status: 'unreviewed',
      }));
      setTasks(prev => [...prev, ...newItems]);
      setHasMore(result.has_more ?? true);
    } catch (e) {
      console.error('Task batch fetch failed', e);
    } finally {
      fetchingRef.current = false;
      setIsFetching(false);
    }
  }, [hasMore, userProfile]);

  // Fetch initial batch on mount
  useEffect(() => {
    fetchBatch([]);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Prefetch when buffer is low
  useEffect(() => {
    const bufferedTasks = tasks.length - page * PAGE_SIZE;
    if (bufferedTasks <= PAGE_SIZE * BUFFER_PAGES && hasMore && !fetchingRef.current) {
      fetchBatch(tasks);
    }
  }, [page, tasks.length, hasMore, fetchBatch, tasks]);

  const visibleTasks = tasks.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const totalPages = Math.ceil(tasks.length / PAGE_SIZE);
  const isLastPage = !hasMore && page >= totalPages - 1;
  const canSeeMore = page < totalPages - 1 || hasMore;

  const setStatus = (idx: number, status: TaskStatus) => {
    setTasks(prev => prev.map((t, i) => i === idx ? { ...t, status } : t));
  };

  const setRecency = (idx: number, recency: TaskRecency) => {
    setTasks(prev => prev.map((t, i) => i === idx ? { ...t, recency } : t));
  };

  const saveEdit = (idx: number, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setTasks(prev => prev.map((t, i) => {
      if (i !== idx) return t;
      const changed = trimmed !== t.originalName;
      if (changed) {
        // Fire bonus toast
        setEditBonusCount(c => c + 1);
        setShowBonusToast(true);
        if (bonusToastTimerRef.current) clearTimeout(bonusToastTimerRef.current);
        bonusToastTimerRef.current = setTimeout(() => setShowBonusToast(false), 2200);
      }
      return { ...t, name: trimmed, status: changed ? 'edited' : t.status };
    }));
  };

  const addCustomTask = (text: string) => {
    const t = text.trim();
    if (!t) return;
    setTasks(prev => [...prev, { name: t, originalName: t, status: 'confirmed' }]);
    setCustomInput('');
    setShowCustom(false);
    // Advance to last page so custom task is visible
    setPage(Math.floor((tasks.length) / PAGE_SIZE));
  };

  const proceed = () => {
    const confirmed = tasks
      .filter(t => t.status === 'confirmed' || t.status === 'edited')
      .map(t => t.name);
    setSelectedTasks(confirmed);
    const coreTask = `${userProfile.jobTitle} — workflow mapping`;
    useWorkflowStore.getState().setCoreTask(coreTask);
    setPhase('workflow');
  };

  const confirmedCount = tasks.filter(t => t.status === 'confirmed' || t.status === 'edited').length;
  const canProceed = confirmedCount >= 1;
  const reviewedCount = tasks.filter(t => t.status !== 'unreviewed').length;

  return (
    <div className="flex flex-col h-full bg-white relative overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-48 bg-gradient-to-b from-indigo-50/30 to-transparent pointer-events-none" />

      {/* Bonus toast */}
      <div className={`absolute top-4 right-4 z-50 transition-all duration-300 ${showBonusToast ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2 pointer-events-none'}`}>
        <div className="flex items-center gap-1.5 px-3 py-2 bg-amber-400 text-amber-900 text-xs font-semibold rounded-full shadow-md">
          <span>★</span>
          <span>Edit bonus earned!</span>
        </div>
      </div>

      {/* Header */}
      <div className="relative z-10 px-8 pt-8 pb-4 shrink-0">
        <div className="flex items-center justify-between mb-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-indigo-400">Part 2 of 3 — Task Coverage</p>
          {editBonusCount > 0 && (
            <span className="flex items-center gap-1 text-[10px] font-semibold text-amber-600 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
              ★ {editBonusCount} edit bonus{editBonusCount !== 1 ? 'es' : ''}
            </span>
          )}
        </div>

        {/* Progress bar */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-500 font-medium">
              {reviewedCount === 0
                ? 'Does each task apply to your role?'
                : `${reviewedCount} reviewed · ${confirmedCount} selected`}
            </span>
            {totalPages > 0 && (
              <span className="text-xs text-slate-400">{page + 1} of {totalPages}{hasMore ? '+' : ''}</span>
            )}
          </div>
          <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-indigo-400 to-violet-400 rounded-full transition-all duration-300 ease-out"
              style={{ width: totalPages > 0 ? `${((page + 1) / Math.max(totalPages, 1)) * 100}%` : '0%' }}
            />
          </div>
        </div>

        <p className="text-[1.4rem] font-light text-slate-800 mt-5 leading-snug tracking-tight">
          Which of these tasks are part of your work?
        </p>
        <p className="text-sm text-slate-400 mt-1.5">
          Select all that apply. Edit any task to make it more accurate — edits earn a bonus.
        </p>
      </div>

      {/* Task cards */}
      <div className="relative z-10 flex-1 overflow-y-auto px-8 pb-4 min-h-0">
        {tasks.length === 0 && isFetching ? (
          <div className="flex items-center justify-center h-32">
            <div className="flex gap-2">
              {[0, 150, 300].map(d => (
                <span key={d} className="w-2 h-2 bg-indigo-200 rounded-full animate-bounce" style={{ animationDelay: `${d}ms` }} />
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-3 pt-2 pb-4">
            {visibleTasks.map((task, localIdx) => {
              const globalIdx = page * PAGE_SIZE + localIdx;
              return (
                <TaskCard
                  key={task.originalName + globalIdx}
                  task={task}
                  idx={globalIdx}
                  onStatus={setStatus}
                  onRecency={setRecency}
                  onSaveEdit={saveEdit}
                />
              );
            })}

            {/* Custom task — last page only */}
            {isLastPage && (
              <div className="pt-2">
                <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-slate-400 mb-2.5">Something missing?</p>
                {showCustom ? (
                  <div className="flex gap-2">
                    <input
                      ref={customRef}
                      autoFocus
                      className="flex-1 border border-slate-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-transparent"
                      placeholder="Describe a task (e.g. Review vendor contracts)"
                      value={customInput}
                      onChange={e => setCustomInput(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') addCustomTask(customInput);
                        if (e.key === 'Escape') { setShowCustom(false); setCustomInput(''); }
                      }}
                    />
                    <button
                      onClick={() => addCustomTask(customInput)}
                      disabled={!customInput.trim()}
                      className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-30 text-white text-sm font-medium rounded-xl transition"
                    >
                      Add
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => { setShowCustom(true); setTimeout(() => customRef.current?.focus(), 50); }}
                    className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl border border-dashed border-slate-300 text-slate-400 hover:border-indigo-300 hover:text-indigo-500 text-sm transition w-full"
                  >
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    Add your own task
                  </button>
                )}
              </div>
            )}

            {isFetching && (
              <div className="flex justify-center py-2">
                <div className="flex gap-1.5">
                  {[0, 100, 200].map(d => (
                    <span key={d} className="w-1.5 h-1.5 bg-indigo-200 rounded-full animate-bounce" style={{ animationDelay: `${d}ms` }} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="relative z-10 px-8 pb-8 pt-4 border-t border-slate-100 shrink-0 space-y-2">
        {canSeeMore && (
          <button
            onClick={() => setPage(p => p + 1)}
            disabled={isFetching && page >= totalPages - 1}
            className="w-full py-3.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-medium rounded-2xl transition-all active:scale-[0.99] shadow-sm shadow-indigo-200"
          >
            See more →
          </button>
        )}
        <button
          onClick={proceed}
          disabled={!canProceed}
          className={`w-full py-3.5 font-medium rounded-2xl transition-all active:scale-[0.99] ${
            isLastPage
              ? 'bg-indigo-600 hover:bg-indigo-700 disabled:opacity-30 text-white shadow-sm shadow-indigo-200'
              : 'bg-white border border-slate-200 text-slate-500 hover:border-slate-300 disabled:opacity-30'
          }`}
        >
          {canProceed
            ? `Continue with ${confirmedCount} task${confirmedCount !== 1 ? 's' : ''} →`
            : 'Select at least one task to continue'}
        </button>
      </div>
    </div>
  );
}

// ── Task card ──────────────────────────────────────────────────────────────────

interface TaskCardProps {
  task: TaskItem;
  idx: number;
  onStatus: (idx: number, status: TaskStatus) => void;
  onRecency: (idx: number, recency: TaskRecency) => void;
  onSaveEdit: (idx: number, name: string) => void;
}

function TaskCard({ task, idx, onStatus, onRecency, onSaveEdit }: TaskCardProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(task.name);
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = () => {
    setEditValue(task.name);
    setEditing(true);
    setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 30);
  };

  const commitEdit = () => {
    setEditing(false);
    const trimmed = editValue.trim() || task.name;
    onSaveEdit(idx, trimmed);
    if (task.status === 'unreviewed') onStatus(idx, 'edited');
  };

  const borderColor = {
    unreviewed: 'border-slate-200',
    confirmed: 'border-green-300',
    edited: 'border-amber-300',
    removed: 'border-slate-200',
  }[task.status];

  const bgColor = {
    unreviewed: 'bg-white',
    confirmed: 'bg-green-50',
    edited: 'bg-amber-50',
    removed: 'bg-slate-50',
  }[task.status];

  const showRecency = task.status === 'confirmed' || task.status === 'edited';

  return (
    <div className={`rounded-2xl border ${borderColor} ${bgColor} p-4 transition-all duration-150 ${task.status === 'removed' ? 'opacity-60' : ''}`}>
      {/* Title row */}
      <div className="flex items-start gap-2 mb-3">
        {editing ? (
          <input
            ref={inputRef}
            className="flex-1 text-sm font-medium text-slate-800 border border-slate-300 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-300"
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
              if (e.key === 'Escape') { setEditing(false); setEditValue(task.name); }
            }}
          />
        ) : (
          <p className={`flex-1 text-sm font-medium leading-snug ${task.status === 'removed' ? 'line-through text-slate-400' : 'text-slate-800'}`}>
            {task.name}
          </p>
        )}
        {task.status === 'edited' && !editing && (
          <span className="flex-shrink-0 text-[10px] font-semibold uppercase tracking-wide text-amber-600 bg-amber-100 px-1.5 py-0.5 rounded">edited</span>
        )}
      </div>

      {/* Action buttons */}
      {!editing && (
        <div className="flex gap-2">
          <ActionBtn
            label="Applies to me"
            active={task.status === 'confirmed'}
            activeClass="bg-green-100 border-green-300 text-green-700"
            onClick={() => onStatus(idx, task.status === 'confirmed' ? 'unreviewed' : 'confirmed')}
          />
          <ActionBtn
            label="Edit"
            active={task.status === 'edited'}
            activeClass="bg-amber-100 border-amber-300 text-amber-700"
            onClick={startEdit}
          />
          <ActionBtn
            label="Doesn't apply"
            active={task.status === 'removed'}
            activeClass="bg-slate-100 border-slate-300 text-slate-500"
            onClick={() => onStatus(idx, task.status === 'removed' ? 'unreviewed' : 'removed')}
          />
        </div>
      )}

      {/* Recency row */}
      {showRecency && (
        <div className="flex items-center gap-2 mt-3 pt-3 border-t border-slate-100">
          <span className="text-[10px] text-slate-400 uppercase tracking-wide font-medium shrink-0">When?</span>
          {(['past', 'current', 'new'] as TaskRecency[]).map(r => (
            <button
              key={r}
              onClick={() => onRecency(idx, r)}
              className={`text-xs px-2.5 py-1 rounded-lg border transition-all ${
                task.recency === r
                  ? 'bg-indigo-100 border-indigo-300 text-indigo-700 font-medium'
                  : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300'
              }`}
            >
              {r === 'past' ? 'Used to do' : r === 'current' ? 'Currently do' : 'Recently started'}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ActionBtn({ label, active, activeClass, onClick }: {
  label: string; active: boolean; activeClass: string; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 text-xs py-1.5 rounded-lg border transition-all font-medium ${
        active ? activeClass : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300 hover:bg-slate-50'
      }`}
    >
      {label}
    </button>
  );
}
