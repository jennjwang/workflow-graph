export type NodeType = 'start' | 'task' | 'decision' | 'handoff' | 'input' | 'failure' | 'wait' | 'end';

export type TaskStatus = 'unreviewed' | 'confirmed' | 'edited' | 'removed';
export type TaskRecency = 'past' | 'current' | 'new';
export type TaskAiUse = 'yes' | 'no' | 'sometimes';
export interface TaskEdit {
  from: string;            // value before this edit
  to: string;              // value after this edit
  charsChanged: number;    // Levenshtein distance from -> to
  timestamp: number;       // ms since epoch
}

export interface TaskItem {
  name: string;
  originalName: string;
  status: TaskStatus;
  category?: string;
  recency?: TaskRecency;
  aiUse?: TaskAiUse;
  aiHowSo?: string;
  edits?: TaskEdit[];          // full chronological history of edits made to this task
  isAttentionCheck?: boolean;  // tasks from clearly unrelated occupations; expected answer is "no"
  addedByParticipant?: boolean; // tasks the participant typed in on the all-done screen
}

export type ClarificationNeeded = 'statement' | 'subtasks' | 'none';

export interface WorkflowNodeData extends Record<string, unknown> {
  label: string;
  description: string;
  nodeType: NodeType;
  actor?: string;
  clarificationNeeded?: ClarificationNeeded;
  clarified?: boolean;
  parentId?: string;
  collapsed?: boolean;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface GraphUpdate {
  tool: 'add_node' | 'add_edge' | 'remove_edge';
  input: Record<string, unknown>;
}

export type Phase = 'setup' | 'background' | 'graph-discovery' | 'task-selection' | 'task-priority' | 'study-complete' | 'screen-out' | 'workflow-kickoff' | 'workflow' | 'actor-assignment' | 'handoff-interview' | 'complete';

export type DiscoveryLevel = 'role' | 'task' | 'subtask';

export type DiscoveryStatus = 'unreviewed' | 'confirmed' | 'rejected';
export type DiscoveryFrequency = 'daily' | 'weekly' | 'monthly' | 'rarely';
export type DiscoveryAiUse = 'yes' | 'no' | 'sometimes';

export interface DiscoveryNodeData extends Record<string, unknown> {
  label: string;
  level: DiscoveryLevel;
  expanded: boolean;
  loading: boolean;
  hasChildren: boolean;
  status: DiscoveryStatus;
  frequency?: DiscoveryFrequency;
  aiUse?: DiscoveryAiUse;
  aiHowSo?: string[];
}

export interface UserProfile {
  // Single free-form field that captures role + tenure from the merged Q1
  // ("What is your current role, and how long have you been in this job?").
  jobTitle: string;
  typicalWeek: string;
  // Q3: open-ended free-form answer to "Out of your weekly activities, are
  // there tasks you're using AI for? Either tasks AI enabled you to do, or
  // new tasks that exist because of AI (like verifying AI output)."
  aiUsage: string;
}

export interface BackgroundTurn {
  field: string;
  question: string;
  answer: string;
  isFollowUp: boolean;
  timestamp: number;
}

export interface BonusSnapshot {
  // Captured at submission so analysts have a frozen record of what the participant
  // earned, independent of any future tweak to the bonus formula or rates.
  editChars: number;
  editEarnedUsd: number;
  editCapped: boolean;
  addCount: number;
  addEarnedUsd: number;
  addCapped: boolean;
  aiHowSoChars: number;
  aiHowSoEarnedUsd: number;
  aiHowSoCapped: boolean;
  totalEarnedUsd: number;
  rates: {
    editPerCharUsd: number;
    editMaxUsd: number;
    addPerTaskUsd: number;
    addMaxUsd: number;
    aiHowSoPerCharUsd: number;
    aiHowSoMaxUsd: number;
  };
  computedAt: string;
}

export interface TaskCategory {
  category: string;
  tasks: string[];
}
