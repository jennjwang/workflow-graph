import { useEffect, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { useWorkflowStore } from './store';
import { Welcome } from './components/Welcome';
import { BackgroundInterview } from './components/BackgroundInterview';
import { TaskSelection } from './components/TaskSelection';
import { TaskPriority } from './components/TaskPriority';
import { WorkflowKickoff } from './components/WorkflowKickoff';
import { WorkflowCanvas } from './components/WorkflowCanvas';
import { WorkflowMapper } from './components/WorkflowMapper';
import { MappingTour } from './components/MappingTour';
import { FinalQuestions } from './components/FinalQuestions';
import { StudyComplete } from './components/StudyComplete';
import { ScreenOut } from './components/ScreenOut';
import { fetchAppConfig, checkScreenStatus, saveSession, saveSessionBeacon } from './lib/api';

export default function App() {
  const phase = useWorkflowStore(s => s.phase);
  const setProlific = useWorkflowStore(s => s.setProlific);
  const setPhase = useWorkflowStore(s => s.setPhase);
  const prolificPid = useWorkflowStore(s => s.prolific.pid);

  // Brief loading window while we check whether this PID has been screened out
  // before. Prevents a flash of the welcome screen for a refresh-after-fail.
  const [bootstrapping, setBootstrapping] = useState<boolean>(!!prolificPid);

  // Fetch the runtime app config (Prolific codes + attention-check threshold) once on mount.
  useEffect(() => {
    fetchAppConfig().then(cfg => {
      setProlific({
        completionCode: cfg.prolificCompletionCode,
        screenOutCode: cfg.prolificScreenOutCode,
        attnCheckMaxFails: cfg.attnCheckMaxFails,
      });
    });
  }, [setProlific]);

  // Top-level auto-save: every phase that mutates persistent state benefits
  // from durable progress. We watch the slices getExportData serializes and
  // debounce 800ms after the last change. Per-phase save effects elsewhere
  // (WorkflowMapper, WorkflowWalker, etc.) layer on top with their own cadence.
  const sessionId = useWorkflowStore(s => s.sessionId);
  const getExportData = useWorkflowStore(s => s.getExportData);
  // Each slice is subscribed individually so the effect re-runs only when one
  // actually changes (avoids the every-render churn of an object selector).
  const userProfile = useWorkflowStore(s => s.userProfile);
  const backgroundTranscript = useWorkflowStore(s => s.backgroundTranscript);
  const taskCategories = useWorkflowStore(s => s.taskCategories);
  const taskItems = useWorkflowStore(s => s.taskItems);
  const selectedTasks = useWorkflowStore(s => s.selectedTasks);
  const coreTask = useWorkflowStore(s => s.coreTask);
  const currentTaskIdx = useWorkflowStore(s => s.currentTaskIdx);
  const typicalWorkflow = useWorkflowStore(s => s.typicalWorkflow);
  const taskWorkflows = useWorkflowStore(s => s.taskWorkflows);
  const nodes = useWorkflowStore(s => s.nodes);
  const edges = useWorkflowStore(s => s.edges);
  const messages = useWorkflowStore(s => s.messages);
  useEffect(() => {
    // Skip phases where a dedicated save runs (FinalQuestions/StudyComplete/
    // ScreenOut each fire their own save on mount or submit).
    if (phase === 'setup' || phase === 'screen-out' || phase === 'final-questions' || phase === 'study-complete') return;
    const handle = setTimeout(() => {
      const data = getExportData() as Record<string, unknown>;
      saveSession(sessionId, undefined, undefined, undefined, data).catch(() => {});
    }, 800);
    return () => clearTimeout(handle);
  }, [phase, sessionId, getExportData, userProfile, backgroundTranscript, taskCategories, taskItems, selectedTasks, coreTask, currentTaskIdx, typicalWorkflow, taskWorkflows, nodes, edges, messages]);

  // Flush the latest state on page unload via sendBeacon so participants who
  // close the tab inside the 800ms debounce window still get their last action
  // persisted. `pagehide` fires reliably on mobile/iOS where `beforeunload`
  // doesn't, so we listen to both.
  //
  // beforeunload additionally triggers the browser's "Leave site?" prompt
  // while the participant is mid-study (anything past `setup` and before
  // `study-complete`) — guards against accidental Back/Cmd-W blowing away
  // their in-progress responses.
  useEffect(() => {
    const PROTECTED_PHASES = new Set([
      'background', 'graph-discovery', 'task-selection', 'task-priority',
      'workflow-kickoff', 'workflow', 'actor-assignment', 'handoff-interview',
      'final-questions',
    ]);
    const promptOnLeave = (e: BeforeUnloadEvent) => {
      const data = getExportData() as Record<string, unknown>;
      saveSessionBeacon(sessionId, data);
      const currentPhase = useWorkflowStore.getState().phase;
      if (PROTECTED_PHASES.has(currentPhase)) {
        e.preventDefault();
        e.returnValue = ''; // required by older browsers to surface the prompt
      }
    };
    const flushOnHide = () => {
      const data = getExportData() as Record<string, unknown>;
      saveSessionBeacon(sessionId, data);
    };
    window.addEventListener('beforeunload', promptOnLeave);
    window.addEventListener('pagehide', flushOnHide);
    return () => {
      window.removeEventListener('beforeunload', promptOnLeave);
      window.removeEventListener('pagehide', flushOnHide);
    };
  }, [sessionId, getExportData]);

  // If this load has a Prolific PID, check whether it was previously screened
  // out. If so, jump straight to the screen-out phase — refreshing the page
  // can't bypass it.
  useEffect(() => {
    if (!prolificPid) return;
    let cancelled = false;
    checkScreenStatus(prolificPid)
      .then(status => {
        if (cancelled) return;
        if (status.screenedOut) {
          setProlific({ screenedOut: true });
          setPhase('screen-out');
        }
      })
      .finally(() => { if (!cancelled) setBootstrapping(false); });
    return () => { cancelled = true; };
  }, [prolificPid, setProlific, setPhase]);

  if (bootstrapping) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div className="flex gap-2">
          {[0, 150, 300].map(d => (
            <span key={d} className="w-2 h-2 bg-indigo-200 rounded-full animate-bounce" style={{ animationDelay: `${d}ms` }} />
          ))}
        </div>
      </div>
    );
  }

  if (phase === 'setup') {
    return <Welcome />;
  }

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
      <div className="relative flex h-screen w-screen overflow-hidden bg-white">
        {/* Gradient spans the full viewport so it doesn't get clipped to the centered column. */}
        <div className="absolute top-0 left-0 right-0 h-48 bg-gradient-to-b from-indigo-50/40 to-transparent pointer-events-none" />
        <div className="relative w-[600px] mx-auto h-full">
          <TaskSelection />
        </div>
      </div>
    );
  }

  if (phase === 'task-priority') {
    return <TaskPriority />;
  }

  if (phase === 'workflow-kickoff') {
    return <WorkflowKickoff />;
  }

  if (phase === 'workflow') {
    return (
      <ReactFlowProvider>
        <div className="relative h-screen w-screen overflow-hidden flex">
          <WorkflowCanvas />
          <WorkflowMapper />
          <MappingTour />
        </div>
      </ReactFlowProvider>
    );
  }

  if (phase === 'final-questions') {
    return <FinalQuestions />;
  }

  if (phase === 'study-complete') {
    return <StudyComplete />;
  }

  if (phase === 'screen-out') {
    return <ScreenOut />;
  }

  return <StudyComplete />;
}
