import { useEffect, useState } from "react";
import { useWorkflowStore } from "./store";
import { Welcome } from "./components/Welcome";
import { BackgroundInterview } from "./components/BackgroundInterview";
import { TaskSelection } from "./components/TaskSelection";
import { FinalQuestions } from "./components/FinalQuestions";
import { OccupationSelect } from "./components/OccupationSelect";
import { StudyComplete } from "./components/StudyComplete";
import { ScreenOut } from "./components/ScreenOut";
import { DevNav } from "./components/DevNav";
import type { Phase } from "./types";
import {
  fetchAppConfig,
  checkScreenStatus,
  fetchSession,
  saveSession,
  saveSessionBeacon,
} from "./lib/api";

// When the URL carries `review=1` we're in the dev page-review mode: skip
// session hydration so the `?dev=<phase>` choice from the DevNav picker sticks
// instead of being overwritten by a saved snapshot's phase.
const REVIEW_MODE =
  new URLSearchParams(window.location.search).get("review") === "1";

// Paste is blocked by default so participants type their own answers. Append
// ?paste=1 to the URL to allow copy/paste (e.g. for testing).
const ALLOW_PASTE =
  new URLSearchParams(window.location.search).get("paste") === "1";

// Preset job profiles for dev testing. Add entries here to test task generation
// with a specific background without going through the interview.
// Usage: ?persona=frontend-engineer&review=1
const DEV_PERSONAS: Record<
  string,
  {
    jobTitle: string;
    responsibilities: string;
    typicalWeek: string;
    outputs: string;
    stakeholders: string;
  }
> = {
  "frontend-engineer": {
    jobTitle: "Frontend Engineer",
    responsibilities:
      "I build and maintain UI components and web applications. I work closely with designers and backend engineers.",
    typicalWeek:
      "Writing React components, reviewing PRs, debugging UI issues, syncing with design, writing tests.",
    outputs:
      "UI components and pages, the shared component library, merged pull requests, bug fixes, and component documentation.",
    stakeholders:
      "Designers, backend engineers, the product manager, and QA. I take specs from design, coordinate API contracts with backend, and hand off built components for QA to test.",
  },
  "product-manager": {
    jobTitle: "Product Manager",
    responsibilities:
      "I define product strategy, write specs, and coordinate between engineering, design, and stakeholders.",
    typicalWeek:
      "Writing PRDs, running sprint planning, reviewing designs, talking to customers, tracking metrics.",
    outputs:
      "PRDs and specs, the product roadmap, sprint plans, release notes, and the metrics dashboard I review weekly.",
    stakeholders:
      "Engineering, design, sales, customer success, and external customers. I gather requirements from customers, align engineering and design, and report progress to leadership.",
  },
  "data-scientist": {
    jobTitle: "Data Scientist",
    responsibilities:
      "I build models and run analyses to inform product and business decisions.",
    typicalWeek:
      "Clean and reshape raw data for analysis and modeling. Cleaning data, training models, writing notebooks, presenting findings, syncing with engineers.",
    outputs:
      "Trained models, analysis notebooks, dashboards, and the findings decks I present to stakeholders.",
    stakeholders:
      "Product managers, data engineers, and business leadership. I take questions from PMs, rely on data engineers for pipelines, and present findings to leadership.",
  },
};

export default function App() {
  const phase = useWorkflowStore((s) => s.phase);
  const setProlific = useWorkflowStore((s) => s.setProlific);
  const setPhase = useWorkflowStore((s) => s.setPhase);
  const addBackgroundTurn = useWorkflowStore((s) => s.addBackgroundTurn);
  const prolificPid = useWorkflowStore((s) => s.prolific.pid);
  const externalId = useWorkflowStore((s) => s.externalId);
  const hydrateFromSnapshot = useWorkflowStore((s) => s.hydrateFromSnapshot);

  // Dev persona seeding: ?persona=<key>&review=1 seeds the store with a preset
  // job profile and jumps straight to task-selection so the real generation
  // pipeline runs without going through the background interview.
  useEffect(() => {
    if (!REVIEW_MODE) return;
    const key = new URLSearchParams(window.location.search).get("persona");
    const persona = key ? DEV_PERSONAS[key] : null;
    if (!persona) return;
    // Seed a synthetic transcript so extractInterviewTasks has something to
    // extract from — without this, grounding is empty and the generator repeats
    // things the persona's profile already covers. The role goes FIRST so the
    // transcript's opening turn is the job title (how role grounding is derived).
    addBackgroundTurn({ field: "jobTitle", question: "What's your current role and field?", answer: persona.jobTitle, isFollowUp: false, timestamp: Date.now() });
    addBackgroundTurn({ field: "responsibilities", question: "What are your primary responsibilities?", answer: persona.responsibilities, isFollowUp: false, timestamp: Date.now() });
    addBackgroundTurn({ field: "typicalWeek", question: "What does a typical week look like?", answer: persona.typicalWeek, isFollowUp: false, timestamp: Date.now() });
    if (persona.outputs) addBackgroundTurn({ field: "outputs", question: "What do you produce, maintain, approve, send, or deliver?", answer: persona.outputs, isFollowUp: false, timestamp: Date.now() });
    if (persona.stakeholders) addBackgroundTurn({ field: "stakeholders", question: "Who do you do your work for or with?", answer: persona.stakeholders, isFollowUp: false, timestamp: Date.now() });
    // Land on task-selection by default, but honor ?dev=<phase> so a persona can
    // be used to seed grounding for any later screen (e.g. occupation-select).
    const devTarget = new URLSearchParams(window.location.search).get("dev") as Phase | null;
    setPhase(devTarget ?? "task-selection");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Brief loading window while we check whether this PID has been screened out
  // before. Prevents a flash of the welcome screen for a refresh-after-fail.
  const [bootstrapping, setBootstrapping] = useState<boolean>(!!prolificPid);
  // Fetching the saved session snapshot to rehydrate the store. True until the
  // GET /api/session call resolves, regardless of whether a snapshot was found.
  const [hydrating, setHydrating] = useState<boolean>(true);

  // Rehydrate from a previously-saved session snapshot. Runs once on mount,
  // before any participant interaction. If the localStorage-pinned sessionId
  // matches an existing snapshot on the server, restore phase + non-canvas
  // state so the participant lands where they left off after a reload. The
  // matching POST autosave path is debounced and the server has a guard that
  // refuses to overwrite a real snapshot with empty state, so a fast-closing
  // tab during this fetch can't clobber the file.
  useEffect(() => {
    if (REVIEW_MODE || prolificPid || externalId) {
      setHydrating(false);
      return;
    }
    let cancelled = false;
    fetchSession(sessionId, externalId)
      .then((snap) => {
        if (cancelled) return;
        if (snap.found && snap.data) {
          const restoredPhase = (snap.data as Record<string, unknown>).phase as string | undefined;
          // Don't restore a completed/terminal session — start fresh instead.
          if (restoredPhase === 'study-complete' || restoredPhase === 'screen-out') return;
          hydrateFromSnapshot(snap.data);
        }
      })
      .finally(() => {
        if (!cancelled) setHydrating(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Block pasting into any text field so participants must type their own
  // answers rather than dropping in pre-written or AI-generated text. A single
  // capture-phase listener covers every <input>, <textarea>, and
  // contentEditable element across the app without touching each component.
  useEffect(() => {
    if (ALLOW_PASTE) return; // switch: ?paste=1 leaves paste enabled
    const blockPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      const tag = t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener("paste", blockPaste, true);
    return () => document.removeEventListener("paste", blockPaste, true);
  }, []);

  // Fetch the runtime app config (Prolific codes + attention-check threshold) once on mount.
  useEffect(() => {
    fetchAppConfig().then((cfg) => {
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
  const sessionId = useWorkflowStore((s) => s.sessionId);
  const getExportData = useWorkflowStore((s) => s.getExportData);
  // Each slice is subscribed individually so the effect re-runs only when one
  // actually changes (avoids the every-render churn of an object selector).
  const backgroundTranscript = useWorkflowStore((s) => s.backgroundTranscript);
  const taskCategories = useWorkflowStore((s) => s.taskCategories);
  const taskItems = useWorkflowStore((s) => s.taskItems);
  const selectedTasks = useWorkflowStore((s) => s.selectedTasks);
  const coreTask = useWorkflowStore((s) => s.coreTask);
  const currentTaskIdx = useWorkflowStore((s) => s.currentTaskIdx);
  const typicalWorkflow = useWorkflowStore((s) => s.typicalWorkflow);
  const taskWorkflows = useWorkflowStore((s) => s.taskWorkflows);
  const nodes = useWorkflowStore((s) => s.nodes);
  const edges = useWorkflowStore((s) => s.edges);
  const messages = useWorkflowStore((s) => s.messages);
  useEffect(() => {
    // In review mode the store is full of seeded dev data — never persist it.
    if (REVIEW_MODE) return;
    // Skip phases where a dedicated save runs (FinalQuestions/StudyComplete/
    // ScreenOut each fire their own save on mount or submit).
    if (
      phase === "setup" ||
      phase === "screen-out" ||
      phase === "final-questions" ||
      phase === "occupation-select" ||
      phase === "study-complete"
    )
      return;
    // Don't autosave until hydration has settled — otherwise a fresh-store
    // POST can race the hydrate fetch. (The server also guards empty-payload
    // overwrites, so this is defense-in-depth.)
    if (hydrating) return;
    const handle = setTimeout(() => {
      const data = getExportData() as Record<string, unknown>;
      saveSession(sessionId, undefined, undefined, undefined, data).catch(
        () => {},
      );
    }, 800);
    return () => clearTimeout(handle);
  }, [
    phase,
    sessionId,
    hydrating,
    getExportData,
    backgroundTranscript,
    taskCategories,
    taskItems,
    selectedTasks,
    coreTask,
    currentTaskIdx,
    typicalWorkflow,
    taskWorkflows,
    nodes,
    edges,
    messages,
  ]);

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
    // Review mode: don't persist seeded data or block navigation, so the DevNav
    // page links reload freely without a "Leave site?" prompt.
    if (REVIEW_MODE) return;
    const PROTECTED_PHASES = new Set([
      "background",
      "graph-discovery",
      "task-selection",
      "final-questions",
    ]);
    const promptOnLeave = (e: BeforeUnloadEvent) => {
      const data = getExportData() as Record<string, unknown>;
      saveSessionBeacon(sessionId, data);
      const currentPhase = useWorkflowStore.getState().phase;
      if (PROTECTED_PHASES.has(currentPhase)) {
        e.preventDefault();
        e.returnValue = ""; // required by older browsers to surface the prompt
      }
    };
    const flushOnHide = () => {
      const data = getExportData() as Record<string, unknown>;
      saveSessionBeacon(sessionId, data);
    };
    window.addEventListener("beforeunload", promptOnLeave);
    window.addEventListener("pagehide", flushOnHide);
    return () => {
      window.removeEventListener("beforeunload", promptOnLeave);
      window.removeEventListener("pagehide", flushOnHide);
    };
  }, [sessionId, getExportData]);

  // If this load has a Prolific PID, check whether it was previously screened
  // out. If so, jump straight to the screen-out phase — refreshing the page
  // can't bypass it.
  useEffect(() => {
    if (!prolificPid) return;
    let cancelled = false;
    checkScreenStatus(prolificPid)
      .then((status) => {
        if (cancelled) return;
        if (status.screenedOut) {
          setProlific({ screenedOut: true });
          setPhase("screen-out");
        }
      })
      .finally(() => {
        if (!cancelled) setBootstrapping(false);
      });
    return () => {
      cancelled = true;
    };
  }, [prolificPid, setProlific, setPhase]);

  if (bootstrapping || hydrating) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div className="flex gap-2">
          {[0, 150, 300].map((d) => (
            <span
              key={d}
              className="w-2 h-2 bg-indigo-200 rounded-full animate-bounce"
              style={{ animationDelay: `${d}ms` }}
            />
          ))}
        </div>
      </div>
    );
  }

  const renderPhase = () => {
    if (phase === "setup") {
      return <Welcome />;
    }

    if (phase === "background") {
      return (
        <div className="flex app-screen w-screen overflow-hidden">
          <div className="flex-1 min-w-0">
            <BackgroundInterview />
          </div>
        </div>
      );
    }

    if (phase === "task-selection") {
      return (
        <div className="relative flex app-screen w-screen overflow-hidden bg-white">
          {/* Gradient spans the full viewport so it doesn't get clipped to the centered column. */}
          <div className="absolute top-0 left-0 right-0 h-48 bg-gradient-to-b from-indigo-50/40 to-transparent pointer-events-none" />
          <div className="relative w-full max-w-[1040px] mx-auto h-full">
            <TaskSelection />
          </div>
        </div>
      );
    }

    if (phase === "final-questions") {
      return <FinalQuestions />;
    }

    if (phase === "occupation-select") {
      return <OccupationSelect />;
    }

    if (phase === "study-complete") {
      return <StudyComplete />;
    }

    if (phase === "screen-out") {
      return <ScreenOut />;
    }

    return <StudyComplete />;
  };

  return (
    <>
      {renderPhase()}
      <DevNav />
    </>
  );
}
