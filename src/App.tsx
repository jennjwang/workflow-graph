import { useEffect, useState } from 'react';
import { useWorkflowStore } from './store';
import { Welcome } from './components/Welcome';
import { BackgroundInterview } from './components/BackgroundInterview';
import { TaskSelection } from './components/TaskSelection';
import { StudyComplete } from './components/StudyComplete';
import { ScreenOut } from './components/ScreenOut';
import { fetchAppConfig, checkScreenStatus } from './lib/api';

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

  if (phase === 'study-complete') {
    return <StudyComplete />;
  }

  if (phase === 'screen-out') {
    return <ScreenOut />;
  }

  // Any other phase (task-priority, legacy Part 3 phases, dev overrides) — fall
  // through to study-complete. Those screens are hidden in this deploy.
  return <StudyComplete />;
}
