export type NodeType = 'start' | 'task' | 'decision' | 'handoff' | 'input' | 'failure' | 'wait' | 'end';

export type TaskStatus = 'unreviewed' | 'confirmed' | 'edited' | 'removed';
export type TaskRecency = 'past' | 'current' | 'new';
export type TaskAiUse = 'yes' | 'no' | 'sometimes';
// Granular relevance rating of a proposed task to the occupation. Replaces the
// binary "I do this / I don't do this" when RELEVANCE_RATING_ENABLED is on. Only
// 'relevant' maps to the keep ("yes") path; every other value drops the task.
export type TaskRelevance =
  | 'relevant'         // Yes, currently relevant
  | 'future'           // Not yet, but likely within 5 years
  | 'other-occupation' // No, performed by workers in a different occupation
  | 'not-valid'        // No, not valid or practical
  | 'unsure';          // Unsure
export interface TaskEdit {
  from: string;            // value before this edit
  to: string;              // value after this edit
  charsChanged: number;    // Levenshtein distance from -> to
  timestamp: number;       // ms since epoch
}

export interface TaskItem {
  name: string;
  originalName: string;
  source?: 'interview' | 'gap';  // provenance: generated from interview extraction vs gap-fill
  status: TaskStatus;
  category?: string;
  recency?: TaskRecency;
  aiUse?: TaskAiUse;
  aiHowSo?: string;
  relevance?: TaskRelevance;   // granular relevance rating (RELEVANCE_RATING_ENABLED mode); replaces the binary keep/drop
  hoursPerWeek?: number;       // self-reported hours spent on this task in a typical week (confirmed tasks only)
  tools?: string;              // tools/software the participant uses for this task (confirmed tasks only)
  edits?: TaskEdit[];          // full chronological history of edits made to this task
  isAttentionCheck?: boolean;  // tasks from clearly unrelated occupations; expected answer is "no"
  addedByParticipant?: boolean; // tasks the participant typed in on the all-done screen
  shownAt?: number;            // epoch ms the card first became the active question
  answeredAt?: number;         // epoch ms the participant answered (yes/no) this card
  timeSpentMs?: number;        // answeredAt - shownAt: dwell time on this card
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
  // false = AI-proposed draft awaiting user confirmation. undefined or true =
  // confirmed (user-added, user-clicked, or legacy node from before this field).
  confirmed?: boolean;
  // The label this node was created with — AI-suggested for addChildNodes,
  // "New subtask" placeholder for addEmptySubtask. Used to compute the
  // per-character edit bonus when the participant renames.
  originalLabel?: string;
  // True for nodes created via addEmptySubtask (the participant's manual +).
  // Used to (a) auto-delete the node if they leave it as the bare placeholder
  // and (b) reverse the addedNodes bonus counter on delete.
  manuallyAdded?: boolean;
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

export type Phase = 'setup' | 'background' | 'graph-discovery' | 'task-selection' | 'task-priority' | 'final-questions' | 'occupation-select' | 'study-complete' | 'screen-out' | 'workflow-kickoff' | 'workflow' | 'actor-assignment' | 'handoff-interview' | 'complete';

// One O*NET-SOC occupation shown on the occupation self-ID screen.
export interface OccupationCandidate {
  code: string;        // O*NET-SOC code, e.g. "15-1252.00"
  title: string;
  definition?: string;
  why?: string;        // model's one-line reason (shown candidates only)
}

// The participant's occupation self-identification. In the default flow this is
// captured AFTER the interview (candidates ranked from the transcript). In the
// SOC-FIRST variant it is captured at the START, before the interview, from a
// job title / description the participant searches with (stored in `query`).
export interface OccupationSelection {
  selectedCode: string;                  // the SOC the participant identified with
  selectedTitle: string;
  fromSearch: boolean;                   // true if picked via free search rather than a shown candidate
  query?: string;                        // SOC-FIRST: the job title / description the participant searched with
  shownSets: OccupationCandidate[][];    // every model-suggested set shown (incl. after "show different")
  rejectedCodes: string[];               // codes cycled past via "show different"
  hints: string[];                       // steerable hints the participant gave
  selectedAt: number;                    // epoch ms
}

// Study condition selected via the ?cond= URL param. `full` runs all three
// parts (background → task selection → task decomposition). `short` skips
// Part 3 and goes straight from task selection to the final questions.
export type StudyCondition = 'full' | 'short';

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
