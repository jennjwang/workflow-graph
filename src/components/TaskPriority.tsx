import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useWorkflowStore } from '../store';

export function TaskPriority() {
  const { selectedTasks, setPhase, setCoreTask } = useWorkflowStore(useShallow(s => ({
    selectedTasks: s.selectedTasks,
    setPhase: s.setPhase,
    setCoreTask: s.setCoreTask,
  })));

  const [picked, setPicked] = useState<string[]>([]);

  const toggle = (task: string) => {
    setPicked(prev =>
      prev.includes(task) ? prev.filter(t => t !== task) : [...prev, task]
    );
  };

  const handleStart = () => {
    if (picked.length === 0) return;
    setCoreTask(picked[0]);
    setPhase('study-complete');
  };

  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center px-8 py-16">
      <div className="absolute top-0 left-0 right-0 h-56 bg-gradient-to-b from-indigo-50/30 to-transparent pointer-events-none" />

      <div className="relative max-w-2xl w-full">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-indigo-400 mb-8">
          Final question
        </p>

        <h1 className="text-[1.85rem] font-light text-slate-800 leading-snug tracking-tight mb-3">
          Which tasks are most important in your job?
        </h1>
        <p className="text-sm text-slate-400 mb-10">
          Select all that apply.
        </p>

        <div className="space-y-2.5 mb-10">
          {selectedTasks.map((task, i) => {
            const letter = String.fromCharCode(65 + i);
            const isSelected = picked.includes(task);
            return (
              <button
                key={task}
                onClick={() => toggle(task)}
                className={`
                  group flex items-center gap-3.5 w-full px-4 py-3.5 rounded-2xl border text-left
                  transition-all duration-150 active:scale-[0.99]
                  ${isSelected
                    ? 'border-indigo-400 bg-indigo-50'
                    : 'border-slate-200/70 hover:border-indigo-300 hover:bg-indigo-50/50 bg-white'}
                `}
              >
                <span className={`
                  flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-xs font-semibold border
                  transition-all duration-150
                  ${isSelected
                    ? 'bg-indigo-500 border-indigo-500 text-white'
                    : 'border-slate-200 text-slate-400 group-hover:bg-indigo-500 group-hover:border-indigo-500 group-hover:text-white'}
                `}>{letter}</span>
                <span className={`text-sm font-medium leading-snug flex-1 ${isSelected ? 'text-indigo-800' : 'text-slate-700'}`}>
                  {task}
                </span>
                {isSelected && (
                  <svg className="w-4 h-4 text-indigo-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>

        <div className="flex items-center justify-between">
          <span className="text-sm text-slate-400">
            {picked.length === 0
              ? 'Select the tasks that matter most'
              : `${picked.length} task${picked.length !== 1 ? 's' : ''} selected`}
          </span>
          <button
            onClick={handleStart}
            disabled={picked.length === 0}
            className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-30 disabled:cursor-not-allowed
                       text-white px-6 py-2.5 rounded-xl text-sm font-medium transition-all"
          >
            Submit →
          </button>
        </div>
      </div>
    </div>
  );
}
