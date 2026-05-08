import { useWorkflowStore } from './store';
import { BackgroundInterview } from './components/BackgroundInterview';
import { TaskSelection } from './components/TaskSelection';
import { TaskPriority } from './components/TaskPriority';
import { WorkflowCanvas } from './components/WorkflowCanvas';
import { WorkflowSidebar } from './components/WorkflowSidebar';

export default function App() {
  const phase = useWorkflowStore(s => s.phase);

  if (phase === 'background') {
    return (
      <div className="flex h-screen w-screen overflow-hidden">
        <div className="flex-1">
          <BackgroundInterview />
        </div>
      </div>
    );
  }

  if (phase === 'task-selection') {
    return (
      <div className="flex h-screen w-screen overflow-hidden bg-white">
        <div className="w-[600px] mx-auto h-full">
          <TaskSelection />
        </div>
      </div>
    );
  }

  if (phase === 'task-priority') {
    return <TaskPriority />;
  }

  // workflow phase: canvas primary + right sidebar
  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <div className="flex-1 min-w-0">
        <WorkflowCanvas />
      </div>
      <WorkflowSidebar />
    </div>
  );
}
