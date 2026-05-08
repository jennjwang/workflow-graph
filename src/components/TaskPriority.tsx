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
    setPhase('workflow');
  };

  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center px-8 py-16">
      <div className="max-w-2xl w-full">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-indigo-400 mb-8">
          Part 3 of 3 — Workflow Mapping
        </p>
        <h1 className="text-3xl font-light text-slate-800 leading-snug mb-2">
          Which tasks are most important to map?
        </h1>
        <p className="text-sm text-slate-400 mb-10">
          Select the ones you'd like to walk through in detail today. We'll start with the first one you pick.
        </p>

        <div className="grid grid-cols-2 gap-3 mb-10">
          {selectedTasks.map((task, idx) => {
            const isSelected = picked.includes(task);
            const order = picked.indexOf(task);
            return (
              <button
                key={task}
                onClick={() => toggle(task)}
                className={`
                  text-left px-4 py-3.5 rounded-2xl border text-sm font-medium
                  transition-all duration-150 flex items-start gap-3
                  ${isSelected
                    ? 'border-indigo-400 bg-indigo-50 text-indigo-800 shadow-sm'
                    : 'border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50'}
                `}
              >
                <span className={`
                  mt-0.5 w-5 h-5 rounded-md flex-shrink-0 flex items-center justify-center
                  border text-[10px] font-bold transition-all
                  ${isSelected
                    ? 'bg-indigo-500 border-indigo-500 text-white'
                    : 'border-slate-300 text-transparent'}
                `}>
                  {isSelected ? order + 1 : idx + 1}
                </span>
                <span className="flex-1 leading-snug">{task}</span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center justify-between">
          <span className="text-sm text-slate-400">
            {picked.length === 0
              ? 'Select the tasks you want to map'
              : `Starting with: "${picked[0]}"`}
          </span>
          <button
            onClick={handleStart}
            disabled={picked.length === 0}
            className="bg-indigo-600 hover:bg-indigo-700 disabled:opacity-30 disabled:cursor-not-allowed
                       text-white px-6 py-2.5 rounded-xl text-sm font-medium transition-all"
          >
            Start Mapping →
          </button>
        </div>
      </div>
    </div>
  );
}
