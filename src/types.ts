export type NodeType = 'start' | 'task' | 'decision';

export type TaskStatus = 'unreviewed' | 'confirmed' | 'edited' | 'removed';
export type TaskRecency = 'past' | 'current' | 'new';
export interface TaskItem {
  name: string;
  originalName: string;
  status: TaskStatus;
  recency?: TaskRecency;
}

export interface WorkflowNodeData extends Record<string, unknown> {
  label: string;
  description: string;
  nodeType: NodeType;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface GraphUpdate {
  tool: 'add_node' | 'add_edge';
  input: Record<string, unknown>;
}

export type Phase = 'setup' | 'background' | 'task-selection' | 'task-priority' | 'workflow' | 'complete';

export interface UserProfile {
  jobTitle: string;
  tenure: string;
  typicalWeek: string;
}

export interface TaskCategory {
  category: string;
  tasks: string[];
}
