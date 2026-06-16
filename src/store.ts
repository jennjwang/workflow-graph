import { create } from 'zustand';
import { Node, Edge, applyEdgeChanges, EdgeChange, Connection, addEdge } from '@xyflow/react';
import { v4 as uuidv4 } from 'uuid';
import { WorkflowNodeData, Message, GraphUpdate, Phase, NodeType, UserProfile, TaskCategory, TaskItem, DiscoveryNodeData, DiscoveryLevel, DiscoveryStatus, BackgroundTurn, BonusSnapshot, StudyCondition } from './types';
import {
  levenshtein,
  mappingEditBonusUsd,
  MAPPING_EDIT_BONUS_PER_CHAR_USD,
  MAPPING_EDIT_BONUS_MAX_USD,
  MAPPING_ADD_NODE_BONUS_USD,
  MAPPING_ADD_NODE_BONUS_MAX_USD,
} from './lib/bonus';

// Max number of essential tasks the participant actually maps. They may pick
// more than this on the priority screen — the extras stay in selectedTasks
// (so the saved record reflects everything they marked essential), but the
// mapping loop stops after this many tasks.
export const MAP_LIMIT = 1;

export interface ProlificContext {
  pid: string | null;
  studyId: string | null;
  sessionId: string | null;
  completionCode: string | null;
  screenOutCode: string | null;
  attnCheckMaxFails: number;
  attnCheckFails: number;
  screenedOut: boolean;
}

interface WorkflowStore {
  sessionId: string;
  // Optional external participant ID — captured from the ?id= URL param so we
  // can recruit users outside of Prolific and still match their saved data
  // back to whoever they are. Null when the link doesn't carry one.
  externalId: string | null;
  // Study condition assigned via the ?cond= URL param. `full` includes Part 3
  // (task-priority → workflow-kickoff → workflow). `short` skips it and jumps
  // straight from task-selection to final-questions.
  condition: StudyCondition;
  phase: Phase;
  // Millisecond epoch when the store first initialized (≈ page load). Used as
  // a session-start proxy for time-spent analysis.
  sessionStartedAt: number;
  // Millisecond epoch the participant first entered each phase. Re-entries (if
  // the participant goes back and forward) keep the FIRST entry, since that's
  // what matters for time-per-phase analysis.
  phaseEnteredAt: Partial<Record<Phase, number>>;

  // Prolific study identifiers — captured from URL params on first mount.
  prolific: ProlificContext;
  setProlific: (p: Partial<ProlificContext>) => void;

  // Phase 1 — background
  userProfile: UserProfile;
  setUserProfile: (profile: UserProfile) => void;
  backgroundTranscript: BackgroundTurn[];
  addBackgroundTurn: (turn: BackgroundTurn) => void;
  bonusSnapshot: BonusSnapshot | null;
  setBonusSnapshot: (snapshot: BonusSnapshot) => void;

  // Graph discovery
  discoveryNodes: Node<DiscoveryNodeData>[];
  discoveryEdges: Edge[];
  discoveryReviewIdx: number;
  setDiscoveryNodeExpanded: (id: string, children: { id: string; label: string; level: DiscoveryLevel; hasChildren: boolean }[]) => void;
  setDiscoveryNodeLoading: (id: string, loading: boolean) => void;
  updateDiscoveryNode: (id: string, data: Partial<DiscoveryNodeData>) => void;
  addDiscoveryTask: (label: string) => void;
  setDiscoveryReviewIdx: (idx: number) => void;
  selectedDiscoveryTasks: string[];

  // Phase 2 — task selection
  taskCategories: TaskCategory[];
  selectedTasks: string[];
  taskItems: TaskItem[];
  // Activities explicitly named by the participant in the background interview,
  // extracted by /api/extract-interview-tasks and used to ground the upper-level
  // generator. Persisted in the session JSON so analysts can audit grounding.
  interviewExtractedTasks: string[];
  setTaskCategories: (cats: TaskCategory[]) => void;
  setSelectedTasks: (tasks: string[]) => void;
  setTaskItems: (items: TaskItem[]) => void;
  setInterviewExtractedTasks: (tasks: string[]) => void;
  toggleTask: (task: string) => void;
  addCustomTask: (task: string) => void;

  // Phase 3 — workflow (coreTask derived from profile)
  coreTask: string;
  setCoreTask: (task: string) => void;
  // A concise canvas/top-bar title derived from coreTask by the kickoff endpoint.
  // Falls back to coreTask if unset.
  coreTaskShort: string;
  setCoreTaskShort: (label: string) => void;
  typicalWorkflow: string[] | null;
  setTypicalWorkflow: (steps: string[]) => void;
  lanes: string[];
  setLanes: (lanes: string[]) => void;
  actorPool: string[];
  addActor: (name: string) => void;
  updateNodeActor: (nodeId: string, actor: string) => void;
  currentTaskIdx: number;
  // Snapshot of each completed task's tree + walkthrough. Populated by
  // advanceToNextTask before it wipes the in-progress state.
  taskWorkflows: { task: string; nodes: { id: string; label: string; description: string; parentId?: string; confirmed: boolean; originalLabel?: string; manuallyAdded: boolean; edited: boolean }[]; edges: { source: string; target: string }[]; messages: { role: 'user' | 'assistant'; content: string }[] }[];
  advanceToNextTask: () => void;
  markNodeClarified: (id: string) => void;
  addChildNodes: (parentId: string, children: { label: string; description: string; type?: NodeType; confirmed?: boolean }[]) => void;
  seedRoot: () => string;
  reparentNode: (nodeId: string, newParentId: string) => boolean;
  spliceNodeIntoEdge: (nodeId: string, edgeSourceId: string, edgeTargetId: string) => boolean;
  addEmptySubtask: (parentId: string) => string;
  confirmNode: (id: string) => void;
  unconfirmNode: (id: string) => void;
  addSubstepChained: (parentId: string, child: { label: string; description?: string; type?: NodeType }) => void;
  toggleNodeCollapsed: (id: string) => void;
  nodes: Node<WorkflowNodeData>[];
  edges: Edge[];
  messages: Message[];
  isLoading: boolean;
  manualPositions: Record<string, { x: number; y: number }>;
  editingNodeId: string | null;
  pendingExpand: { nodeId: string; nodeLabel: string } | null;
  setPendingExpand: (v: { nodeId: string; nodeLabel: string } | null) => void;
  // Tells the canvas to animate-fit to these node ids on the next paint.
  // Set by addChildNodes / addEmptySubtask; cleared by the canvas after focusing.
  pendingFocus: string[] | null;
  setPendingFocus: (ids: string[]) => void;
  clearPendingFocus: () => void;
  // Labels of AI-proposed sub-tasks the participant deleted, keyed by parent
  // node id. Used as a rejection-history signal when /api/propose-subtasks is
  // called for the same parent ("you suggested these last time; they said no").
  rejectedByParent: Record<string, string[]>;
  currentExploreNodeId: string | null;
  setCurrentExploreNodeId: (id: string | null) => void;

  // Coach-mark tour shown on first task in the mapping phase. tourStep is
  // -1 when inactive; 0..N-1 while running.
  tourStep: number;
  tourCompleted: boolean;
  startTour: () => void;
  advanceTour: () => void;
  endTour: () => void;
  // ID of the node whose hover-revealed "+" button should be forced visible by
  // the tour (e.g. during the "Add your own" step so participants can see what
  // the bullet refers to). Cleared when the step changes.
  tourSpotlightAddNode: string | null;
  setTourSpotlightAddNode: (id: string | null) => void;

  // Set to true the first time the participant keeps a drafted subtask. Used
  // to drop the per-card "tap to keep" hint once they've learned the gesture.
  // Session-level so it persists across task resets.
  hasLearnedKeepGesture: boolean;

  // Cumulative Levenshtein characters edited across all tasks for the mapping
  // edit bonus. Survives task resets so the bonus pool accumulates session-wide.
  mappingEditChars: number;
  // Count of manually-added subtasks across all tasks. Drives a flat
  // per-node add bonus (MAPPING_ADD_NODE_BONUS_USD). Survives task resets.
  mappingAddedNodes: number;

  // Tracks which task indices have already started their kickoff (root + first
  // AI-proposed children). React StrictMode double-mounts the WorkflowMapper in
  // dev, so a useRef guard inside the component isn't sufficient; this lives in
  // the store so the second mount sees the first one's flag and bails out.
  kickoffStartedForTasks: number[];
  markKickoffStarted: (taskIdx: number) => boolean;

  setPhase: (phase: Phase) => void;
  // Final-questions answers — kept in the store so getExportData() carries them
  // into the defense-in-depth save fired from StudyComplete on mount.
  experienceRating: number | null;
  feedback: string;
  setFinalAnswers: (answers: { experienceRating: number; feedback: string }) => void;
  // Self-reported total hours worked in an average week, collected at the top of
  // the time-allocation section (distinct from the sum of per-task hours).
  avgWeeklyHours: number | null;
  setAvgWeeklyHours: (hours: number | null) => void;
  addMessage: (role: 'user' | 'assistant', content: string) => void;
  setLoading: (loading: boolean) => void;
  applyGraphUpdates: (updates: GraphUpdate[]) => void;

  // Walker overlay — ghost nodes/edges + card node anchored to a real node
  walkerOverlayNodes: Node<WorkflowNodeData>[];
  walkerOverlayEdges: Edge[];
  setWalkerOverlay: (nodes: Node<WorkflowNodeData>[], edges: Edge[]) => void;
  setManualPosition: (id: string, position: { x: number; y: number }) => void;
  updateNodeLabel: (id: string, label: string) => void;
  deleteNodes: (ids: string[]) => void;
  createNode: (type: NodeType, position: { x: number; y: number }, sourceId?: string) => string;
  setEditingNodeId: (id: string | null) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  getExportData: () => object;
  // Restore persistent state from a previously-saved snapshot (returned by
  // GET /api/session). Restores phase + all non-canvas state. The in-progress
  // workflow canvas (nodes/edges/messages) is intentionally skipped because
  // node positions aren't saved; if the snapshot's phase was 'workflow', it's
  // downgraded to 'workflow-kickoff' so the current task re-kicks off.
  hydrateFromSnapshot: (data: Record<string, unknown>) => void;
}

const urlParams = new URLSearchParams(window.location.search);
const devPhase = (urlParams.get('dev') as Phase | null) ?? 'setup';
// Restrict the URL-supplied external ID to filename-safe chars so the server
// can splice it into a path without escaping concerns. Empty after sanitizing → null.
const rawExternalId = urlParams.get('id');
const initialExternalId = rawExternalId
  ? (rawExternalId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || null)
  : null;
const initialCondition: StudyCondition = urlParams.get('cond') === 'short' ? 'short' : 'full';
const initialProlific: ProlificContext = {
  pid: urlParams.get('PROLIFIC_PID'),
  studyId: urlParams.get('STUDY_ID'),
  sessionId: urlParams.get('SESSION_ID'),
  completionCode: null,
  screenOutCode: null,
  attnCheckMaxFails: 0,
  attnCheckFails: 0,
  screenedOut: false,
};

const SESSION_START_MS = Date.now();

// Persist sessionId across page reloads so an accidental browser back/refresh
// can resume against the same server-side JSON. Keyed by PROLIFIC_PID so each
// Prolific participant gets their own slot, and so re-using the same browser
// for a new study (new PID) starts a fresh session.
function getOrCreateSessionId(): string {
  try {
    const pid = urlParams.get('PROLIFIC_PID') || 'default';
    const key = `wf-graph-session-${pid}`;
    const stored = window.localStorage?.getItem(key);
    if (stored) return stored;
    const fresh = uuidv4();
    window.localStorage?.setItem(key, fresh);
    return fresh;
  } catch {
    // localStorage can throw in private windows / SSR — fall back to a
    // process-lifetime UUID.
    return uuidv4();
  }
}

export const useWorkflowStore = create<WorkflowStore>((set, get) => ({
  sessionId: getOrCreateSessionId(),
  externalId: initialExternalId,
  condition: initialCondition,
  phase: devPhase,
  sessionStartedAt: SESSION_START_MS,
  // Seed the initial phase with the same start time so phaseEnteredAt always
  // has an entry for whatever phase the participant landed on.
  phaseEnteredAt: { [devPhase]: SESSION_START_MS } as Partial<Record<Phase, number>>,

  prolific: initialProlific,
  setProlific: (p) => set(state => ({ prolific: { ...state.prolific, ...p } })),

  userProfile: {
    responsibilities: '',
    jobTitle: '',
    typicalWeek: '',
    aiUsage: '',
    outputs: '',
    stakeholders: '',
    tools: '',
    invisibleWork: '',
  },
  setUserProfile: (userProfile) => set({ userProfile }),
  backgroundTranscript: [],
  addBackgroundTurn: (turn) =>
    set(state => ({ backgroundTranscript: [...state.backgroundTranscript, turn] })),
  bonusSnapshot: null,
  setBonusSnapshot: (bonusSnapshot) => set({ bonusSnapshot }),

  discoveryNodes: [],
  discoveryEdges: [],
  discoveryReviewIdx: 0,
  selectedDiscoveryTasks: [],
  setDiscoveryReviewIdx: (discoveryReviewIdx) => set({ discoveryReviewIdx }),
  setDiscoveryNodeLoading: (id, loading) =>
    set(state => ({
      discoveryNodes: state.discoveryNodes.map(n =>
        n.id === id ? { ...n, data: { ...n.data, loading } } : n
      ),
    })),
  updateDiscoveryNode: (id, data) =>
    set(state => {
      const nodes = state.discoveryNodes.map(n =>
        n.id === id ? { ...n, data: { ...n.data, ...data } } : n
      );
      const selectedDiscoveryTasks = nodes
        .filter(n => n.data.status === 'confirmed')
        .map(n => n.id);
      return { discoveryNodes: nodes, selectedDiscoveryTasks };
    }),
  addDiscoveryTask: (label) =>
    set(state => {
      const id = `custom_${Date.now()}`;
      const newNode: Node<DiscoveryNodeData> = {
        id, type: 'discovery',
        position: { x: 0, y: 0 },
        data: { label, level: 'task', expanded: false, loading: false, hasChildren: true, status: 'unreviewed' },
      };
      const rootId = state.discoveryNodes.find(n => n.data.level === 'role')?.id;
      const newEdge: Edge | null = rootId
        ? { id: `${rootId}->${id}`, source: rootId, target: id, style: { stroke: '#e2e8f0', strokeWidth: 2 } }
        : null;
      return {
        discoveryNodes: [...state.discoveryNodes, newNode],
        discoveryEdges: newEdge ? [...state.discoveryEdges, newEdge] : state.discoveryEdges,
      };
    }),
  setDiscoveryNodeExpanded: (parentId, children) =>
    set(state => {
      const newNodes: Node<DiscoveryNodeData>[] = children.map((c, i) => ({
        id: c.id,
        type: 'discovery',
        position: { x: 0, y: i * 140 },
        data: { label: c.label, level: c.level, expanded: false, loading: false, hasChildren: c.hasChildren, status: 'unreviewed' as DiscoveryStatus },
      }));
      const newEdges: Edge[] = children.map(c => ({
        id: `${parentId}->${c.id}`,
        source: parentId,
        target: c.id,
        style: { stroke: '#e2e8f0', strokeWidth: 2 },
      }));
      return {
        discoveryNodes: [
          ...state.discoveryNodes.map(n =>
            n.id === parentId ? { ...n, data: { ...n.data, expanded: true, loading: false } } : n
          ),
          ...newNodes,
        ],
        discoveryEdges: [...state.discoveryEdges, ...newEdges],
      };
    }),

  // Starts empty — /api/generate-tasks populates this from the participant's
  // background interview answers. The previous PM-flavored placeholder
  // categories ("Write a PRD", "Sync with engineering"…) were stale dev seeds
  // and could leak into a participant's task list if generation failed.
  taskCategories: [],
  // Starts empty — populated when the participant confirms tasks on the
  // TaskSelection screen. Previously seeded with a dev fixture, which leaked
  // into incomplete sessions and made them look pre-filled.
  selectedTasks: [],
  taskItems: [],
  interviewExtractedTasks: [],
  setTaskCategories: (taskCategories) => set({ taskCategories }),
  setSelectedTasks: (selectedTasks) => set({ selectedTasks }),
  setTaskItems: (taskItems) => set({ taskItems }),
  setInterviewExtractedTasks: (interviewExtractedTasks) => set({ interviewExtractedTasks }),
  toggleTask: (task) =>
    set(state => ({
      selectedTasks: state.selectedTasks.includes(task)
        ? state.selectedTasks.filter(t => t !== task)
        : [...state.selectedTasks, task],
    })),
  addCustomTask: (task) =>
    set(state => {
      const custom = state.taskCategories.find(c => c.category === 'My Tasks');
      if (custom) {
        return {
          taskCategories: state.taskCategories.map(c =>
            c.category === 'My Tasks' ? { ...c, tasks: [...c.tasks, task] } : c
          ),
          selectedTasks: [...state.selectedTasks, task],
        };
      }
      return {
        taskCategories: [...state.taskCategories, { category: 'My Tasks', tasks: [task] }],
        selectedTasks: [...state.selectedTasks, task],
      };
    }),

  coreTask: '',
  setCoreTask: (coreTask) => set({ coreTask }),
  coreTaskShort: '',
  setCoreTaskShort: (coreTaskShort) => set({ coreTaskShort }),
  markNodeClarified: (id) => set(state => ({
    nodes: state.nodes.map(n =>
      n.id === id ? { ...n, data: { ...n.data, clarified: true } } : n
    ),
  })),
  toggleNodeCollapsed: (id) => set(state => ({
    nodes: state.nodes.map(n =>
      n.id === id ? { ...n, data: { ...n.data, collapsed: !n.data.collapsed } } : n
    ),
  })),
  addSubstepChained: (parentId, child) => set(state => {
    const ts = Date.now();
    const idx = state.nodes.filter(n => n.data.parentId === parentId).length;
    const newId = `${parentId}_sub_${ts}_${idx}`;
    const nodeType: NodeType = child.type ?? 'task';
    const newNode: Node<WorkflowNodeData> = {
      id: newId,
      type: nodeType,
      position: { x: 0, y: 0 },
      data: { label: child.label, description: child.description ?? '', nodeType, clarified: true, parentId },
    };
    // Find current "tail" sub-step — a sibling that is not the source of any sibling-chain edge.
    const siblings = state.nodes.filter(n => n.data.parentId === parentId);
    const siblingIds = new Set(siblings.map(s => s.id));
    const sibsWithChainOut = new Set(state.edges.filter(e => siblingIds.has(e.source) && siblingIds.has(e.target)).map(e => e.source));
    const tails = siblings.filter(s => !sibsWithChainOut.has(s.id));
    const tail = tails[tails.length - 1] ?? null;
    const newEdges: Edge[] = tail ? [{
      id: `${tail.id}->${newId}`,
      source: tail.id,
      target: newId,
      style: { stroke: '#94a3b8', strokeDasharray: '4,3' },
    }] : [];
    return {
      nodes: [...state.nodes, newNode],
      edges: [...state.edges, ...newEdges],
    };
  }),

  seedRoot: () => {
    const state = get();
    const existing = state.nodes.find(n => !n.data.parentId);
    if (existing) return existing.id;
    const id = `root_${Date.now()}`;
    // Display the AI-generated short label on the canvas; preserve the full
    // (possibly long, possibly edited) task text as the description so it can
    // still inform AI prompts and surface on hover.
    const label = state.coreTaskShort || state.coreTask;
    const description = state.coreTaskShort && state.coreTaskShort !== state.coreTask
      ? state.coreTask
      : '';
    const rootNode: Node<WorkflowNodeData> = {
      id, type: 'task',
      position: { x: 0, y: 0 },
      data: { label, description, nodeType: 'task', clarified: true },
    };
    set({ nodes: [rootNode], edges: [] });
    return id;
  },

  reparentNode: (nodeId, newParentId) => {
    if (nodeId === newParentId) return false;
    const state = get();
    const node = state.nodes.find(n => n.id === nodeId);
    if (!node || !node.data.parentId) return false; // root has no parent and can't be reparented
    if (node.data.parentId === newParentId) return false;

    // Reject cycles: newParentId must not be the moved node or any of its descendants.
    const descendants = new Set<string>([nodeId]);
    const queue = [nodeId];
    while (queue.length) {
      const pid = queue.shift()!;
      for (const n of state.nodes) {
        if (n.data.parentId === pid && !descendants.has(n.id)) {
          descendants.add(n.id);
          queue.push(n.id);
        }
      }
    }
    if (descendants.has(newParentId)) return false;

    const oldParentId = node.data.parentId;
    const oldEdgeId = `${oldParentId}->${nodeId}`;
    const newEdgeId = `${newParentId}->${nodeId}`;

    // Move the reparented node to the END of the nodes array so layoutTree's
    // sibling-stabilization (which sorts visible siblings by their index in the
    // input `nodes` array) places it at the bottom of the new parent's children.
    // Without this, the node keeps its original index and lands ABOVE existing
    // siblings of the new parent — reshuffling vertical order that the
    // participant didn't ask for. Other nodes preserve their relative order.
    const updatedNode = { ...node, data: { ...node.data, parentId: newParentId } };
    const nextNodes = [
      ...state.nodes.filter(n => n.id !== nodeId),
      updatedNode,
    ];

    set({
      nodes: nextNodes,
      edges: [
        ...state.edges.filter(e => e.id !== oldEdgeId && e.id !== newEdgeId),
        {
          id: newEdgeId,
          source: newParentId,
          target: nodeId,
          style: { stroke: '#cbd5e1', strokeWidth: 1.5 },
        },
      ],
      // Full reset: any node a participant manually positioned would otherwise
      // stay locked and could overlap the freshly relaid subtree. Clearing
      // everything lets dagre re-layout the whole canvas cleanly.
      manualPositions: {},
    });
    return true;
  },

  spliceNodeIntoEdge: (nodeId, srcId, tgtId) => {
    // "Insert into chain" semantic: dropping X on edge A→B re-slots X between
    // them. Result: A → X → B. X's old parent link is broken (e.g. A → B → C
    // dropping C on A → B becomes A → C → B, not a cycle).
    if (nodeId === srcId || nodeId === tgtId) return false;
    const state = get();
    const node = state.nodes.find(n => n.id === nodeId);
    const tgt = state.nodes.find(n => n.id === tgtId);
    if (!node || !tgt) return false;
    if (!node.data.parentId) return false; // root can't be moved
    const oldNodeParentId = node.data.parentId;

    // Cycle check: making X a child of A would cycle iff X is an ancestor of A.
    // (X being a descendant of B is fine — we're breaking X's old parent link.)
    let cur: string | undefined = state.nodes.find(n => n.id === srcId)?.data.parentId;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      if (cur === nodeId) return false;
      seen.add(cur);
      cur = state.nodes.find(n => n.id === cur)?.data.parentId;
    }

    const oldNodeEdgeId = `${oldNodeParentId}->${nodeId}`;
    const oldSpliceEdgeId = `${srcId}->${tgtId}`;
    const newSrcToNodeEdgeId = `${srcId}->${nodeId}`;
    const newNodeToTgtEdgeId = `${nodeId}->${tgtId}`;
    const stripIds = new Set([oldNodeEdgeId, oldSpliceEdgeId, newSrcToNodeEdgeId, newNodeToTgtEdgeId]);

    set({
      nodes: state.nodes.map(n => {
        if (n.id === nodeId) return { ...n, data: { ...n.data, parentId: srcId } };
        if (n.id === tgtId) return { ...n, data: { ...n.data, parentId: nodeId } };
        return n;
      }),
      edges: [
        ...state.edges.filter(e => !stripIds.has(e.id)),
        { id: newSrcToNodeEdgeId, source: srcId, target: nodeId, style: { stroke: '#cbd5e1', strokeWidth: 1.5 } },
        { id: newNodeToTgtEdgeId, source: nodeId, target: tgtId, style: { stroke: '#cbd5e1', strokeWidth: 1.5 } },
      ],
      // Full reset (see reparentNode): everything reflows so no card overlaps another.
      manualPositions: {},
    });
    return true;
  },

  confirmNode: (id) => set(state => ({
    nodes: state.nodes.map(n =>
      n.id === id ? { ...n, data: { ...n.data, confirmed: true } } : n
    ),
    hasLearnedKeepGesture: true,
  })),

  unconfirmNode: (id) => set(state => ({
    nodes: state.nodes.map(n =>
      n.id === id ? { ...n, data: { ...n.data, confirmed: false } } : n
    ),
  })),

  addEmptySubtask: (parentId) => {
    const id = `${parentId}_sub_${Date.now()}`;
    set(state => ({
      nodes: [
        ...state.nodes,
        {
          id, type: 'task',
          // originalLabel intentionally omitted — manually-added subtasks earn
          // the flat MAPPING_ADD_NODE_BONUS_USD, not per-character edit credit,
          // so updateNodeLabel must skip the Levenshtein delta for them.
          // manuallyAdded flag drives (a) auto-delete if the participant leaves
          // the bare "New subtask" placeholder and (b) reversing the add-node
          // bonus counter when the subtask is deleted.
          position: { x: 0, y: 0 },
          data: { label: 'New subtask', description: '', nodeType: 'task', clarified: true, parentId, manuallyAdded: true },
        },
      ],
      edges: [
        ...state.edges,
        { id: `${parentId}->${id}`, source: parentId, target: id, style: { stroke: '#cbd5e1', strokeWidth: 1.5 } },
      ],
      editingNodeId: id,
      // Focus on the new empty node alone — the participant is about to type
      // into it, so we want it zoomed in, not framed alongside its parent.
      pendingFocus: [id],
      mappingAddedNodes: state.mappingAddedNodes + 1,
    }));
    return id;
  },

  addChildNodes: (parentId, children) => set(state => {
    if (children.length === 0) return state;
    const ts = Date.now();
    const subIds = children.map((_, i) => `${parentId}_sub_${ts}_${i}`);
    const newNodes: Node<WorkflowNodeData>[] = children.map((c, i) => {
      const nodeType: NodeType = c.type ?? 'task';
      return {
        id: subIds[i],
        type: nodeType,
        position: { x: 0, y: 0 },
        // originalLabel snapshots the AI suggestion so we can credit the
        // participant's per-character edits later in updateNodeLabel.
        data: { label: c.label, description: c.description, nodeType, clarified: true, parentId, confirmed: c.confirmed ?? true, originalLabel: c.label },
      };
    });

    // Pure-tree edges: one parent→child line per new node. No sibling chains.
    const newEdges: Edge[] = subIds.map(id => ({
      id: `${parentId}->${id}`,
      source: parentId,
      target: id,
      style: { stroke: '#cbd5e1', strokeWidth: 1.5 },
    }));

    return {
      nodes: [...state.nodes, ...newNodes],
      edges: [...state.edges, ...newEdges],
      pendingFocus: [parentId, ...subIds],
    };
  }),
  currentTaskIdx: 0,
  taskWorkflows: [],
  advanceToNextTask: () => set(state => {
    // Archive the current task's tree + walkthrough so it survives the reset.
    const archived = state.nodes.length > 0
      ? [
          ...state.taskWorkflows,
          {
            task: state.coreTask,
            nodes: state.nodes.map(n => ({
              id: n.id,
              label: n.data.label,
              description: n.data.description,
              parentId: n.data.parentId,
              confirmed: n.data.confirmed !== false,
              // Provenance: how this node arrived on the canvas and whether
              // the participant changed its label after.
              originalLabel: n.data.originalLabel,
              manuallyAdded: !!n.data.manuallyAdded,
              edited: n.data.originalLabel !== undefined && n.data.label !== n.data.originalLabel,
            })),
            edges: state.edges.map(e => ({ source: e.source, target: e.target })),
            messages: state.messages.map(m => ({ role: m.role, content: m.content })),
          },
        ]
      : state.taskWorkflows;
    const nextIdx = state.currentTaskIdx + 1;
    const mapCount = Math.min(state.selectedTasks.length, MAP_LIMIT);
    const nextTask = state.selectedTasks[nextIdx] ?? '';
    const nextPhase: Phase = nextIdx < mapCount ? 'workflow-kickoff' : 'final-questions';
    return {
      taskWorkflows: archived,
      currentTaskIdx: nextIdx,
      coreTask: nextTask,
      coreTaskShort: '',
      nodes: [],
      edges: [],
      messages: [],
      manualPositions: {},
      typicalWorkflow: null,
      currentExploreNodeId: null,
      phase: nextPhase,
      // Stamp first entry only — going back into workflow-kickoff for task 2+
      // is the FIRST entry to a fresh task, but the phase has been visited
      // before. We keep the original timestamp; per-task timing is implicit
      // from the taskWorkflows array length + currentTaskIdx changes.
      phaseEnteredAt: state.phaseEnteredAt[nextPhase]
        ? state.phaseEnteredAt
        : { ...state.phaseEnteredAt, [nextPhase]: Date.now() },
    };
  }),
  typicalWorkflow: null,
  setTypicalWorkflow: (typicalWorkflow) => set({ typicalWorkflow }),
  lanes: [],
  setLanes: (lanes) => set({ lanes }),
  actorPool: ['Me', 'Team member', 'Manager', 'External system', 'AI tool'],
  addActor: (name) => set(state => ({
    actorPool: state.actorPool.includes(name) ? state.actorPool : [...state.actorPool, name],
    lanes: state.lanes.includes(name) ? state.lanes : [...state.lanes, name],
  })),
  updateNodeActor: (nodeId, actor) => set(state => {
    const nodes = state.nodes.map(n =>
      n.id === nodeId ? { ...n, data: { ...n.data, actor } } : n
    );
    const assignedActors = [...new Set(nodes.map(n => n.data.actor).filter(Boolean))] as string[];
    const lanes = assignedActors.filter(a => state.actorPool.includes(a) || assignedActors.includes(a));
    return { nodes, lanes };
  }),
  nodes: [],
  edges: [],
  messages: [],
  isLoading: false,
  pendingExpand: null,
  setPendingExpand: (pendingExpand) => set({ pendingExpand }),
  pendingFocus: null,
  setPendingFocus: (pendingFocus) => set({ pendingFocus }),
  clearPendingFocus: () => set({ pendingFocus: null }),
  rejectedByParent: {},
  currentExploreNodeId: null,
  setCurrentExploreNodeId: (currentExploreNodeId) => set({ currentExploreNodeId }),
  tourStep: -1,
  tourCompleted: false,
  startTour: () => set(state => state.tourCompleted ? {} : { tourStep: 0 }),
  advanceTour: () => set(state => ({ tourStep: state.tourStep + 1 })),
  endTour: () => set({ tourStep: -1, tourCompleted: true, tourSpotlightAddNode: null }),
  tourSpotlightAddNode: null,
  setTourSpotlightAddNode: (tourSpotlightAddNode) => set({ tourSpotlightAddNode }),
  hasLearnedKeepGesture: false,
  mappingEditChars: 0,
  mappingAddedNodes: 0,
  kickoffStartedForTasks: [],
  // Atomically claims a kickoff slot. Returns true if this is the first claim
  // for taskIdx (caller should proceed); false if already claimed.
  markKickoffStarted: (taskIdx) => {
    const state = get();
    if (state.kickoffStartedForTasks.includes(taskIdx)) return false;
    set({ kickoffStartedForTasks: [...state.kickoffStartedForTasks, taskIdx] });
    return true;
  },
  manualPositions: {},
  editingNodeId: null,

  setPhase: (phase) => set(state => ({
    phase,
    // Stamp the first-entry time only — re-entries keep the original so the
    // "time spent on this phase" duration isn't reset by a back-and-forth.
    phaseEnteredAt: state.phaseEnteredAt[phase]
      ? state.phaseEnteredAt
      : { ...state.phaseEnteredAt, [phase]: Date.now() },
  })),
  experienceRating: null,
  feedback: '',
  setFinalAnswers: ({ experienceRating, feedback }) => set({ experienceRating, feedback }),
  avgWeeklyHours: null,
  setAvgWeeklyHours: (avgWeeklyHours) => set({ avgWeeklyHours }),
  setLoading: (isLoading) => set({ isLoading }),
  setEditingNodeId: (editingNodeId) => set({ editingNodeId }),

  addMessage: (role, content) =>
    set(state => ({
      messages: [
        ...state.messages,
        { id: uuidv4(), role, content, timestamp: Date.now() },
      ],
    })),

  setManualPosition: (id, position) =>
    set(state => ({ manualPositions: { ...state.manualPositions, [id]: position } })),

  updateNodeLabel: (id, label) =>
    set(state => {
      const node = state.nodes.find(n => n.id === id);
      // Credit edits against the node's originalLabel. Only AI-suggested
      // nodes set originalLabel (the proposed text); manually-added subtasks
      // leave it undefined and earn the flat add-node bonus instead.
      let editCharsDelta = 0;
      if (node?.data.originalLabel !== undefined) {
        const oldDist = levenshtein(node.data.originalLabel, node.data.label);
        const newDist = levenshtein(node.data.originalLabel, label);
        editCharsDelta = newDist - oldDist;
      }
      return {
        nodes: state.nodes.map(n =>
          n.id === id ? { ...n, data: { ...n.data, label } } : n
        ),
        mappingEditChars: Math.max(0, state.mappingEditChars + editCharsDelta),
      };
    }),

  deleteNodes: (ids) =>
    set(state => {
      // Cascade: collect the input ids plus every descendant.
      const toDelete = new Set<string>(ids);
      const queue = [...ids];
      while (queue.length) {
        const pid = queue.shift()!;
        for (const n of state.nodes) {
          if (n.data.parentId === pid && !toDelete.has(n.id)) {
            toDelete.add(n.id);
            queue.push(n.id);
          }
        }
      }
      // Reverse bonus contributions for each deleted node so a participant
      // can't earn the add-bonus or edit-bonus and then keep it by deleting
      // the subtask. Mirrors the credit logic in updateNodeLabel + addEmptySubtask.
      let editCharsToReverse = 0;
      let addedNodesToReverse = 0;
      // Track AI-proposed labels that just got discarded, grouped by their
      // parent. Fed to /api/propose-subtasks as rejection signal next time the
      // same parent is expanded — "you suggested this last round; they said no".
      // Only items that came from the AI count (originalLabel set, not manuallyAdded);
      // we use the originalLabel rather than the current label so a participant
      // who renamed then deleted still teaches the AI about the original.
      const newRejections: Record<string, string[]> = {};
      for (const n of state.nodes) {
        if (!toDelete.has(n.id)) continue;
        if (n.data.originalLabel !== undefined) {
          editCharsToReverse += levenshtein(n.data.originalLabel, n.data.label);
        }
        if (n.data.manuallyAdded) addedNodesToReverse += 1;
        if (n.data.originalLabel && !n.data.manuallyAdded && n.data.parentId) {
          (newRejections[n.data.parentId] ||= []).push(n.data.originalLabel);
        }
      }
      const mergedRejections: Record<string, string[]> = { ...state.rejectedByParent };
      for (const [parentId, labels] of Object.entries(newRejections)) {
        const existing = mergedRejections[parentId] ?? [];
        const set = new Set([...existing, ...labels]);
        mergedRejections[parentId] = [...set];
      }
      const manualPositions = { ...state.manualPositions };
      toDelete.forEach(id => delete manualPositions[id]);
      return {
        nodes: state.nodes.filter(n => !toDelete.has(n.id)),
        edges: state.edges.filter(e => !toDelete.has(e.source) && !toDelete.has(e.target)),
        manualPositions,
        mappingEditChars: Math.max(0, state.mappingEditChars - editCharsToReverse),
        mappingAddedNodes: Math.max(0, state.mappingAddedNodes - addedNodesToReverse),
        rejectedByParent: mergedRejections,
      };
    }),

  createNode: (type, position, sourceId) => {
    const id = `node_${uuidv4().slice(0, 8)}`;
    set(state => {
      const newNode: Node<WorkflowNodeData> = {
        id,
        type,
        position: { x: 0, y: 0 },
        data: { label: 'New ' + type, description: '', nodeType: type },
      };
      const newEdges = sourceId
        ? addEdge(
            { source: sourceId, target: id, id: `${sourceId}->${id}`, style: { stroke: '#6b7280' } },
            state.edges
          )
        : state.edges;
      return {
        nodes: [...state.nodes, newNode],
        edges: newEdges,
        manualPositions: { ...state.manualPositions, [id]: position },
        editingNodeId: id,
      };
    });
    return id;
  },

  onEdgesChange: (changes) =>
    set(state => ({ edges: applyEdgeChanges(changes, state.edges) })),

  onConnect: (connection) =>
    set(state => ({
      edges: addEdge(
        { ...connection, id: `${connection.source}->${connection.target}`, style: { stroke: '#6b7280' } },
        state.edges
      ),
    })),

  walkerOverlayNodes: [],
  walkerOverlayEdges: [],
  setWalkerOverlay: (walkerOverlayNodes, walkerOverlayEdges) => set({ walkerOverlayNodes, walkerOverlayEdges }),

  applyGraphUpdates: (updates) =>
    set(state => {
      let nodes = [...state.nodes];
      let edges = [...state.edges];

      for (const update of updates) {
        if (update.tool === 'add_node') {
          const input = update.input as { id: string; type: NodeType; label: string; description: string; actor?: string; clarificationNeeded?: 'statement' | 'subtasks' | 'none'; parentId?: string };
          // start/end/decision never need clarification (decisions branch — they don't decompose into sub-steps)
          const noClarifyByType = input.type === 'start' || input.type === 'end' || input.type === 'decision';
          const effectiveClarification = noClarifyByType
            ? 'none'
            : (input.clarificationNeeded ?? 'subtasks');

          // Enforce exactly one start and one end node — skip duplicates
          if (input.type === 'start' && nodes.some(n => n.data.nodeType === 'start')) continue;
          if (input.type === 'end' && nodes.some(n => n.data.nodeType === 'end')) continue;

          if (!nodes.find(n => n.id === input.id)) {
            nodes.push({
              id: input.id,
              type: input.type,
              position: { x: 0, y: 0 },
              data: {
                label: input.label,
                description: input.description,
                nodeType: input.type,
                actor: input.actor,
                parentId: input.parentId,
                clarificationNeeded: effectiveClarification,
                clarified: input.parentId ? true : effectiveClarification === 'none',
              },
            });
          }
        } else if (update.tool === 'add_edge') {
          const input = update.input as { source: string; target: string; label?: string; is_branch?: boolean };
          const edgeId = `${input.source}->${input.target}`;
          if (!edges.find(e => e.id === edgeId)) {
            edges.push({
              id: edgeId,
              source: input.source,
              target: input.target,
              label: input.label,
              animated: false,
              style: input.is_branch ? { stroke: '#f97316', strokeDasharray: '5,5' } : { stroke: '#6b7280' },
              data: { is_branch: input.is_branch ?? false },
            });
          }
        } else if (update.tool === 'remove_edge') {
          const input = update.input as { source: string; target: string };
          edges = edges.filter(e => !(e.source === input.source && e.target === input.target));
        }
      }

      return { nodes, edges };
    }),

  getExportData: () => {
    const { sessionId, externalId, condition, prolific, userProfile, backgroundTranscript, selectedTasks, taskItems, taskCategories, interviewExtractedTasks, coreTask, typicalWorkflow, bonusSnapshot, nodes, edges, messages, taskWorkflows, currentTaskIdx, experienceRating, feedback, avgWeeklyHours, sessionStartedAt, phaseEnteredAt, mappingEditChars, mappingAddedNodes } = get();
    // Live-computed mapping bonus, recorded on every save so the persisted
    // session always reflects what the participant has earned so far in the
    // workflow-mapping phase (raw counters are alongside for verification).
    const mappingBonus = mappingEditBonusUsd(mappingEditChars, mappingAddedNodes);
    const mappingBonusSnapshot = {
      editChars: mappingEditChars,
      editEarnedUsd: mappingBonus.editUsd,
      editCapped: mappingBonus.editUsd >= MAPPING_EDIT_BONUS_MAX_USD,
      addCount: mappingAddedNodes,
      addEarnedUsd: mappingBonus.addUsd,
      addCapped: mappingBonus.addUsd >= MAPPING_ADD_NODE_BONUS_MAX_USD,
      totalEarnedUsd: mappingBonus.usd,
      rates: {
        editPerCharUsd: MAPPING_EDIT_BONUS_PER_CHAR_USD,
        editMaxUsd: MAPPING_EDIT_BONUS_MAX_USD,
        addPerNodeUsd: MAPPING_ADD_NODE_BONUS_USD,
        addMaxUsd: MAPPING_ADD_NODE_BONUS_MAX_USD,
      },
      computedAt: new Date().toISOString(),
    };
    // Completion signal — `study-complete` lands in phaseEnteredAt the moment
    // the participant arrives at the thanks screen. Surfacing it as a top-level
    // boolean (plus an ISO timestamp) so analysts can split completers from
    // abandoners without parsing the phaseEnteredAt map.
    const completedAtMs = phaseEnteredAt?.['study-complete'];
    const completed = typeof completedAtMs === 'number';
    const completedAt = completed ? new Date(completedAtMs).toISOString() : null;
    return {
      sessionId,
      externalId,
      condition,
      phase: get().phase,
      completed,
      completedAt,
      prolific,
      userProfile,
      backgroundTranscript,
      interviewExtractedTasks,
      taskCategories,
      selectedTasks,
      taskItems,
      coreTask,
      currentTaskIdx,
      typicalWorkflow,
      bonusSnapshot,
      // Mapping-phase bonuses — both the raw counters (ground truth) and the
      // computed snapshot (convenience for analysts).
      mappingEditChars,
      mappingAddedNodes,
      mappingBonusSnapshot,
      experienceRating,
      feedback,
      avgWeeklyHours,
      sessionStartedAt,
      phaseEnteredAt,
      exportedAt: new Date().toISOString(),
      // Completed tasks (one entry per task the participant finished before
      // advancing to the next).
      taskWorkflows,
      // The in-progress task (whatever they're currently working on, if any).
      workflow: {
        nodes: nodes.map(n => ({
          id: n.id,
          type: n.type,
          label: n.data.label,
          description: n.data.description,
          actor: n.data.actor,
          parentId: n.data.parentId,
          confirmed: n.data.confirmed !== false,
          // Provenance for analysts: which label the AI proposed, whether the
          // participant added this node themselves, and whether the current
          // label differs from the AI suggestion.
          originalLabel: n.data.originalLabel,
          manuallyAdded: !!n.data.manuallyAdded,
          edited: n.data.originalLabel !== undefined && n.data.label !== n.data.originalLabel,
        })),
        edges: edges.map(e => ({ source: e.source, target: e.target, label: e.label, is_branch: e.data?.is_branch })),
      },
      transcript: messages.map(m => ({ role: m.role, content: m.content })),
    };
  },

  hydrateFromSnapshot: (data) => set(state => {
    const d = data as Record<string, unknown>;
    const next: Partial<WorkflowStore> = {};

    if (d.condition === 'short' || d.condition === 'full') next.condition = d.condition;
    if (typeof d.externalId === 'string' && state.externalId === null) {
      next.externalId = d.externalId;
    }
    if (d.userProfile && typeof d.userProfile === 'object') {
      next.userProfile = { ...state.userProfile, ...(d.userProfile as Partial<UserProfile>) };
    }
    if (Array.isArray(d.backgroundTranscript)) next.backgroundTranscript = d.backgroundTranscript as BackgroundTurn[];
    if (Array.isArray(d.taskCategories)) next.taskCategories = d.taskCategories as TaskCategory[];
    if (Array.isArray(d.selectedTasks)) next.selectedTasks = d.selectedTasks as string[];
    if (Array.isArray(d.taskItems)) next.taskItems = d.taskItems as TaskItem[];
    if (Array.isArray(d.interviewExtractedTasks)) next.interviewExtractedTasks = d.interviewExtractedTasks as string[];
    if (typeof d.coreTask === 'string') next.coreTask = d.coreTask;
    if (typeof d.currentTaskIdx === 'number') next.currentTaskIdx = d.currentTaskIdx;
    if (Array.isArray(d.typicalWorkflow)) next.typicalWorkflow = d.typicalWorkflow as string[];
    if (Array.isArray(d.taskWorkflows)) {
      next.taskWorkflows = d.taskWorkflows as WorkflowStore['taskWorkflows'];
    }
    if (typeof d.mappingEditChars === 'number') next.mappingEditChars = d.mappingEditChars;
    if (typeof d.mappingAddedNodes === 'number') next.mappingAddedNodes = d.mappingAddedNodes;
    if (d.bonusSnapshot && typeof d.bonusSnapshot === 'object') {
      next.bonusSnapshot = d.bonusSnapshot as BonusSnapshot;
    }
    if (typeof d.experienceRating === 'number') next.experienceRating = d.experienceRating;
    if (typeof d.feedback === 'string') next.feedback = d.feedback;
    if (typeof d.avgWeeklyHours === 'number') next.avgWeeklyHours = d.avgWeeklyHours;
    if (d.phaseEnteredAt && typeof d.phaseEnteredAt === 'object') {
      next.phaseEnteredAt = d.phaseEnteredAt as WorkflowStore['phaseEnteredAt'];
    }
    if (d.prolific && typeof d.prolific === 'object') {
      const savedProlific = d.prolific as Partial<ProlificContext>;
      // Keep URL-derived PID/STUDY_ID/SESSION_ID when present; otherwise fall
      // back to saved values. completionCode/screenOutCode/attnCheckMaxFails
      // come back from /api/config, so saved values are fine as a stopgap
      // until that fetch resolves.
      next.prolific = {
        ...state.prolific,
        ...savedProlific,
        pid: state.prolific.pid ?? savedProlific.pid ?? null,
        studyId: state.prolific.studyId ?? savedProlific.studyId ?? null,
        sessionId: state.prolific.sessionId ?? savedProlific.sessionId ?? null,
      };
    }

    // Determine the phase to restore. Prefer the explicit `phase` field;
    // fall back to deriving from phaseEnteredAt (latest by timestamp) for
    // snapshots saved before `phase` was added to the export.
    let savedPhase: Phase | null = null;
    if (typeof d.phase === 'string') {
      savedPhase = d.phase as Phase;
    } else if (next.phaseEnteredAt) {
      const entries = Object.entries(next.phaseEnteredAt);
      if (entries.length > 0) {
        entries.sort(([, a], [, b]) => (b as number) - (a as number));
        savedPhase = entries[0][0] as Phase;
      }
    }
    // The in-progress canvas isn't restored (positions aren't saved), so a
    // participant who reloaded mid-mapping is sent back to re-kick off the
    // current task. Already-completed tasks live in taskWorkflows.
    if (savedPhase === 'workflow') savedPhase = 'workflow-kickoff';
    if (savedPhase) next.phase = savedPhase;

    return next;
  }),
}));
