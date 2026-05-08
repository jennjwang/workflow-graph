import { useState } from 'react';
import { useWorkflowStore } from '../store';

export function SetupScreen() {
  const [input, setInput] = useState('');
  const setCoreTask = useWorkflowStore(s => s.setCoreTask);
  const setPhase = useWorkflowStore(s => s.setPhase);

  const start = () => {
    const task = input.trim();
    if (!task) return;
    setCoreTask(task);
    setPhase('workflow');
  };

  return (
    <div className="flex items-center justify-center h-full bg-gray-50">
      <div className="bg-white rounded-2xl shadow-md p-10 w-full max-w-lg">
        <h1 className="text-2xl font-bold text-gray-800 mb-2">Workflow Mapper</h1>
        <p className="text-gray-500 mb-8 text-sm">
          An AI interviewer will guide you through mapping your workflow step by step.
          The graph on the right will build up as you talk.
        </p>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          What is the core task you want to map?
        </label>
        <input
          className="w-full border border-gray-300 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 mb-6"
          placeholder="e.g. Submit a research paper, Onboard a new employee…"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && start()}
          autoFocus
        />
        <button
          onClick={start}
          disabled={!input.trim()}
          className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white font-semibold py-3 rounded-lg transition"
        >
          Start Interview →
        </button>
      </div>
    </div>
  );
}
