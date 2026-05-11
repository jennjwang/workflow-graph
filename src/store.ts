import { create } from 'zustand';
import { Node, Edge, applyEdgeChanges, EdgeChange, Connection, addEdge } from '@xyflow/react';
import { v4 as uuidv4 } from 'uuid';
import { WorkflowNodeData, Message, GraphUpdate, Phase, NodeType, UserProfile, TaskCategory, TaskItem, DiscoveryNodeData, DiscoveryLevel, DiscoveryStatus, BackgroundTurn, BonusSnapshot } from './types';

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
  phase: Phase;

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
  setTaskCategories: (cats: TaskCategory[]) => void;
  setSelectedTasks: (tasks: string[]) => void;
  setTaskItems: (items: TaskItem[]) => void;
  toggleTask: (task: string) => void;
  addCustomTask: (task: string) => void;

  // Phase 3 — workflow (coreTask derived from profile)
  coreTask: string;
  setCoreTask: (task: string) => void;
  typicalWorkflow: string[] | null;
  setTypicalWorkflow: (steps: string[]) => void;
  lanes: string[];
  setLanes: (lanes: string[]) => void;
  actorPool: string[];
  addActor: (name: string) => void;
  updateNodeActor: (nodeId: string, actor: string) => void;
  currentTaskIdx: number;
  advanceToNextTask: () => void;
  markNodeClarified: (id: string) => void;
  addChildNodes: (parentId: string, children: { label: string; description: string; type?: NodeType }[]) => void;
  addSubstepChained: (parentId: string, child: { label: string; description: string; type?: NodeType }) => void;
  toggleNodeCollapsed: (id: string) => void;
  nodes: Node<WorkflowNodeData>[];
  edges: Edge[];
  messages: Message[];
  isLoading: boolean;
  manualPositions: Record<string, { x: number; y: number }>;
  editingNodeId: string | null;
  pendingExpand: { nodeId: string; nodeLabel: string } | null;
  setPendingExpand: (v: { nodeId: string; nodeLabel: string } | null) => void;
  currentExploreNodeId: string | null;
  setCurrentExploreNodeId: (id: string | null) => void;

  setPhase: (phase: Phase) => void;
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
}

const urlParams = new URLSearchParams(window.location.search);
const devPhase = (urlParams.get('dev') as Phase | null) ?? 'setup';
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

const DEV_KICKOFF_ANSWER = "I look at the code and leave comments, then approve or ask for changes.";

export const useWorkflowStore = create<WorkflowStore>((set, get) => ({
  sessionId: uuidv4(),
  phase: devPhase,

  prolific: initialProlific,
  setProlific: (p) => set(state => ({ prolific: { ...state.prolific, ...p } })),

  // Dev default — used when entering task-selection / workflow phases via ?dev= URL
  // without going through the background interview. Replaced by real answers in production.
  userProfile: { jobTitle: 'PhD student in computer science, 3 years', typicalWeek: 'Reading papers, running experiments, writing code, meeting with my advisor, drafting paper sections, attending lab meetings, mentoring undergrads', aiUsage: '' },
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

  taskCategories: [
    { category: 'Planning & Strategy', tasks: ['Write a PRD', 'Run sprint planning', 'Define roadmap priorities', 'Set OKRs'] },
    { category: 'Collaboration', tasks: ['Sync with engineering', 'Sync with design', 'Run stakeholder reviews', 'Lead team standups'] },
    { category: 'Execution & Delivery', tasks: ['Review pull requests', 'Triage bugs', 'Write release notes', 'Coordinate launches'] },
    { category: 'Analysis & Reporting', tasks: ['Review metrics dashboards', 'Write weekly updates', 'Conduct user interviews', 'Analyze A/B tests'] },
  ],
  selectedTasks: ['Write a PRD', 'Run sprint planning', 'Review pull requests'],
  taskItems: [],
  setTaskCategories: (taskCategories) => set({ taskCategories }),
  setSelectedTasks: (selectedTasks) => set({ selectedTasks }),
  setTaskItems: (taskItems) => set({ taskItems }),
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

  coreTask: devPhase === 'workflow' ? 'Review pull requests' : 'Write a PRD',
  setCoreTask: (coreTask) => set({ coreTask }),
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
      data: { label: child.label, description: child.description, nodeType, clarified: true, parentId },
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
        data: { label: c.label, description: c.description, nodeType, clarified: true, parentId },
      };
    });

    // Children form their own sub-flow chained sequentially. Parent stays in the main
    // flow untouched (its existing outgoing edges are preserved).
    const newEdges: Edge[] = [];
    for (let i = 0; i < subIds.length - 1; i++) {
      newEdges.push({
        id: `${subIds[i]}->${subIds[i + 1]}`,
        source: subIds[i],
        target: subIds[i + 1],
        style: { stroke: '#94a3b8', strokeDasharray: '4,3' },
      });
    }

    return {
      nodes: [...state.nodes, ...newNodes],
      edges: [...state.edges, ...newEdges],
    };
  }),
  currentTaskIdx: 0,
  advanceToNextTask: () => set(state => {
    const nextIdx = state.currentTaskIdx + 1;
    const nextTask = state.selectedTasks[nextIdx] ?? '';
    return {
      currentTaskIdx: nextIdx,
      coreTask: nextTask,
      nodes: [],
      edges: [],
      messages: [],
      manualPositions: {},
      typicalWorkflow: null,
      currentExploreNodeId: null,
      phase: nextIdx < state.selectedTasks.length ? 'workflow-kickoff' : 'complete',
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
  messages: devPhase === 'workflow' ? [
    { id: '__q__', role: 'assistant' as const, content: 'Can you walk me through how you review pull requests from start to finish?', timestamp: 0 },
    { id: '__a__', role: 'user' as const, content: DEV_KICKOFF_ANSWER, timestamp: 1 },
  ] : [],
  isLoading: false,
  pendingExpand: null,
  setPendingExpand: (pendingExpand) => set({ pendingExpand }),
  currentExploreNodeId: null,
  setCurrentExploreNodeId: (currentExploreNodeId) => set({ currentExploreNodeId }),
  manualPositions: {},
  editingNodeId: null,

  setPhase: (phase) => set({ phase }),
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
    set(state => ({
      nodes: state.nodes.map(n =>
        n.id === id ? { ...n, data: { ...n.data, label } } : n
      ),
    })),

  deleteNodes: (ids) =>
    set(state => {
      const idSet = new Set(ids);
      const manualPositions = { ...state.manualPositions };
      ids.forEach(id => delete manualPositions[id]);
      return {
        nodes: state.nodes.filter(n => !idSet.has(n.id)),
        edges: state.edges.filter(e => !idSet.has(e.source) && !idSet.has(e.target)),
        manualPositions,
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
    const { sessionId, prolific, userProfile, backgroundTranscript, selectedTasks, taskItems, taskCategories, coreTask, typicalWorkflow, bonusSnapshot, nodes, edges, messages } = get();
    return {
      sessionId,
      prolific,
      userProfile,
      backgroundTranscript,
      taskCategories,
      selectedTasks,
      taskItems,
      coreTask,
      typicalWorkflow,
      bonusSnapshot,
      exportedAt: new Date().toISOString(),
      workflow: {
        nodes: nodes.map(n => ({ id: n.id, type: n.type, label: n.data.label, description: n.data.description, actor: n.data.actor, parentId: n.data.parentId })),
        edges: edges.map(e => ({ source: e.source, target: e.target, label: e.label, is_branch: e.data?.is_branch })),
      },
      transcript: messages.map(m => ({ role: m.role, content: m.content })),
    };
  },
}));
