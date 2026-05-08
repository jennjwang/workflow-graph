import { create } from 'zustand';
import { Node, Edge, applyEdgeChanges, EdgeChange, Connection, addEdge } from '@xyflow/react';
import { v4 as uuidv4 } from 'uuid';
import { WorkflowNodeData, Message, GraphUpdate, Phase, NodeType, UserProfile, TaskCategory } from './types';

interface WorkflowStore {
  sessionId: string;
  phase: Phase;

  // Phase 1 — background
  userProfile: UserProfile;
  setUserProfile: (profile: UserProfile) => void;

  // Phase 2 — task selection
  taskCategories: TaskCategory[];
  selectedTasks: string[];
  setTaskCategories: (cats: TaskCategory[]) => void;
  setSelectedTasks: (tasks: string[]) => void;
  toggleTask: (task: string) => void;
  addCustomTask: (task: string) => void;

  // Phase 3 — workflow (coreTask derived from profile)
  coreTask: string;
  setCoreTask: (task: string) => void;
  nodes: Node<WorkflowNodeData>[];
  edges: Edge[];
  messages: Message[];
  isLoading: boolean;
  manualPositions: Record<string, { x: number; y: number }>;
  editingNodeId: string | null;

  setPhase: (phase: Phase) => void;
  addMessage: (role: 'user' | 'assistant', content: string) => void;
  setLoading: (loading: boolean) => void;
  applyGraphUpdates: (updates: GraphUpdate[]) => void;
  setManualPosition: (id: string, position: { x: number; y: number }) => void;
  updateNodeLabel: (id: string, label: string) => void;
  deleteNodes: (ids: string[]) => void;
  createNode: (type: NodeType, position: { x: number; y: number }, sourceId?: string) => string;
  setEditingNodeId: (id: string | null) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  getExportData: () => object;
}

export const useWorkflowStore = create<WorkflowStore>((set, get) => ({
  sessionId: uuidv4(),
  phase: 'task-selection',

  userProfile: { jobTitle: 'Product Manager', tenure: '3 years', typicalWeek: 'Running sprint planning, writing PRDs, syncing with engineering and design, reviewing metrics dashboards' },
  setUserProfile: (userProfile) => set({ userProfile }),

  taskCategories: [
    { category: 'Planning & Strategy', tasks: ['Write a PRD', 'Run sprint planning', 'Define roadmap priorities', 'Set OKRs'] },
    { category: 'Collaboration', tasks: ['Sync with engineering', 'Sync with design', 'Run stakeholder reviews', 'Lead team standups'] },
    { category: 'Execution & Delivery', tasks: ['Review pull requests', 'Triage bugs', 'Write release notes', 'Coordinate launches'] },
    { category: 'Analysis & Reporting', tasks: ['Review metrics dashboards', 'Write weekly updates', 'Conduct user interviews', 'Analyze A/B tests'] },
  ],
  selectedTasks: ['Write a PRD', 'Run sprint planning', 'Review pull requests'],
  setTaskCategories: (taskCategories) => set({ taskCategories }),
  setSelectedTasks: (selectedTasks) => set({ selectedTasks }),
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

  coreTask: 'Write a PRD',
  setCoreTask: (coreTask) => set({ coreTask }),
  nodes: [],
  edges: [],
  messages: [],
  isLoading: false,
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

  applyGraphUpdates: (updates) =>
    set(state => {
      let nodes = [...state.nodes];
      let edges = [...state.edges];

      for (const update of updates) {
        if (update.tool === 'add_node') {
          const input = update.input as { id: string; type: NodeType; label: string; description: string };
          if (!nodes.find(n => n.id === input.id)) {
            nodes.push({
              id: input.id,
              type: input.type,
              position: { x: 0, y: 0 },
              data: { label: input.label, description: input.description, nodeType: input.type },
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
        }
      }

      return { nodes, edges };
    }),

  getExportData: () => {
    const { sessionId, userProfile, selectedTasks, nodes, edges, messages } = get();
    return {
      sessionId,
      userProfile,
      selectedTasks,
      exportedAt: new Date().toISOString(),
      workflow: {
        nodes: nodes.map(n => ({ id: n.id, type: n.type, label: n.data.label, description: n.data.description })),
        edges: edges.map(e => ({ source: e.source, target: e.target, label: e.label, is_branch: e.data?.is_branch })),
      },
      transcript: messages.map(m => ({ role: m.role, content: m.content })),
    };
  },
}));
