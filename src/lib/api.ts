import { Message, GraphUpdate, UserProfile } from '../types';

export interface Suggestion {
  label: string;
  type: 'task' | 'decision' | 'branch';
}

export interface SuggestionSet {
  prompt: string | null;
  items: Suggestion[];
}

export async function expandDiscoveryNode(
  jobTitle: string,
  nodeLabel: string,
  level: string,
  ancestors: string[],
): Promise<{ children: { id: string; label: string; level: string; hasChildren: boolean }[] }> {
  const res = await fetch('/api/expand-node', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobTitle, nodeLabel, level, ancestors }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export type GapLens = 'missing' | 'decompose' | 'dependency' | string;

export interface GapItem {
  id: string;
  lens: GapLens;
  anchor_node_id: string;
  title: string;
  rationale: string;
  proposed_changes: GraphUpdate[];
  // Legacy fields kept for back-compat with older endpoint shapes
  summary?: string;
  question?: string;
}

export type InterviewStepKind = 'transition' | 'missing' | 'decompose';

export interface InterviewStep {
  kind: InterviewStepKind;
  anchor_node_id: string;
  prev_node_id?: string;
  question: string;
  edge_label?: string;
  suggestions?: { label: string; description: string; type: import('../types').NodeType }[];
  proposed_task?: { id: string; label: string; description: string; type: import('../types').NodeType };
}

export async function fetchInterview(
  nodes: { id: string; type: string; label: string; description?: string }[],
  edges: { source: string; target: string; label?: string }[],
  coreTask: string,
  jobTitle: string,
  participantOverview?: string,
): Promise<InterviewStep[]> {
  const res = await fetch('/api/walker-interview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodes, edges, coreTask, jobTitle, participantOverview }),
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.steps ?? [];
}

export async function analyzeGaps(
  nodes: { id: string; type: string; label: string; description?: string }[],
  edges: { source: string; target: string; label?: string }[],
  coreTask: string,
  jobTitle: string,
  participantOverview?: string,
): Promise<GapItem[]> {
  const res = await fetch('/api/gap-analysis', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodes, edges, coreTask, jobTitle, participantOverview }),
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.gaps ?? [];
}

export async function suggestActors(transcript: string, jobTitle: string): Promise<string[]> {
  const res = await fetch('/api/suggest-actors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript, jobTitle }),
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.actors ?? ['Me'];
}

export async function sendHandoffMessage(
  messages: Message[],
  nodes: { id: string; type: string; label: string; actor?: string }[],
  edges: { source: string; target: string }[],
  coreTask: string,
  userProfile: UserProfile | null,
  onGraphUpdate?: (update: GraphUpdate) => void,
  onSuggestions?: (items: SuggestionSet['items']) => void,
): Promise<{ message: string }> {
  const res = await fetch('/api/handoff-chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, nodes, edges, coreTask, userProfile }),
  });
  if (!res.ok) throw new Error(await res.text());

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalMessage = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const lines = part.split('\n');
      const eventLine = lines.find(l => l.startsWith('event: '));
      const dataLine = lines.find(l => l.startsWith('data: '));
      if (!eventLine || !dataLine) continue;
      const event = eventLine.slice(7);
      const data = JSON.parse(dataLine.slice(6));
      if (event === 'graph_update') onGraphUpdate?.(data as GraphUpdate);
      else if (event === 'suggestions') onSuggestions?.(data.items);
      else if (event === 'done') finalMessage = data.message;
      else if (event === 'error') throw new Error(data.error);
    }
  }
  return { message: finalMessage };
}

export async function proposeSubtasks(
  taskLabel: string,
  coreTask: string,
  jobTitle: string,
  statementClarification?: string,
  existingNodes?: { id: string; label: string; type: string }[],
): Promise<{ label: string; description: string; type: import('../types').NodeType; linkToExistingId?: string }[]> {
  const res = await fetch('/api/propose-subtasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskLabel, coreTask, jobTitle, statementClarification, existingNodes }),
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.subtasks ?? [];
}

export interface ProposedEdge {
  source: string;
  target: string;
  label?: string;
  is_branch?: boolean;
  confidence: 'high' | 'medium' | 'low';
}

export async function proposeRelationships(
  nodes: { id: string; label: string; parentId?: string }[],
  coreTask: string,
  jobTitle: string,
): Promise<ProposedEdge[]> {
  const res = await fetch('/api/propose-relationships', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodes, coreTask, jobTitle }),
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.edges ?? [];
}

export async function expandTask(
  taskLabel: string,
  coreTask: string,
  jobTitle: string
): Promise<{ id: string; label: string; description: string }[]> {
  const res = await fetch('/api/expand-task', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskLabel, coreTask, jobTitle }),
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.subtasks ?? [];
}

export async function fetchTypicalWorkflow(jobTitle: string, coreTask: string): Promise<string[]> {
  const res = await fetch('/api/typical-workflow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobTitle, coreTask }),
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.steps as string[];
}

export async function sendChatMessage(
  messages: Message[],
  coreTask: string,
  nodes: { id: string; type: string; label: string }[],
  skipSuggestions = false,
  userProfile?: UserProfile | null,
  selectedTasks?: string[],
  typicalWorkflow?: string[] | null,
  onGraphUpdate?: (update: GraphUpdate) => void,
  onCurrentNode?: (nodeId: string) => void,
  onSetLanes?: (lanes: string[]) => void,
): Promise<{ message: string; graphUpdates: GraphUpdate[]; suggestions: SuggestionSet | null; currentNodeId: string | null }> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, coreTask, nodes, skipSuggestions, userProfile, selectedTasks, typicalWorkflow }),
  });
  if (!res.ok) throw new Error(await res.text());

  const graphUpdates: GraphUpdate[] = [];
  let finalResult: { message: string; suggestions: SuggestionSet | null; currentNodeId: string | null } | null = null;

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const lines = part.split('\n');
      const eventLine = lines.find(l => l.startsWith('event: '));
      const dataLine = lines.find(l => l.startsWith('data: '));
      if (!eventLine || !dataLine) continue;
      const event = eventLine.slice(7);
      const data = JSON.parse(dataLine.slice(6));
      if (event === 'graph_update') {
        graphUpdates.push(data as GraphUpdate);
        onGraphUpdate?.(data as GraphUpdate);
      } else if (event === 'current_node') {
        onCurrentNode?.(data.nodeId);
      } else if (event === 'set_lanes') {
        onSetLanes?.(data.lanes);
      } else if (event === 'done') {
        finalResult = data;
      } else if (event === 'error') {
        throw new Error(data.error);
      }
    }
  }

  if (!finalResult) throw new Error('Stream ended without done event');
  return { ...finalResult, graphUpdates };
}

export async function evaluateAnswer(
  question: string,
  answer: string,
  criteria: string[],
  maxFollowups: number,
  followupCount: number,
  evaluationStyle: 'lenient' | 'strict' = 'lenient',
): Promise<{ allCovered: boolean; followUp: string | null }> {
  const res = await fetch('/api/evaluate-answer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, answer, criteria, maxFollowups, followupCount, evaluationStyle }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function generateCategories(
  jobTitle: string,
  typicalWeek: string,
): Promise<{ name: string; description: string }[]> {
  const res = await fetch('/api/generate-categories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobTitle, typicalWeek }),
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.categories ?? [];
}

export async function generateTasksForCategory(
  jobTitle: string,
  typicalWeek: string,
  category: string,
  priorTasks: string[] = [],
  count?: number,
  aiUsage?: string,
): Promise<string[]> {
  const res = await fetch('/api/generate-tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobTitle, typicalWeek, category, priorTasks, count, aiUsage }),
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return (data.tasks ?? []).map((t: { name: string }) => t.name);
}

export async function transcribeAudio(blob: Blob): Promise<string> {
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
  const res = await fetch('/api/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio: base64, mimeType: blob.type }),
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.text as string;
}

export interface AppConfig {
  prolificCompletionCode: string | null;
  prolificScreenOutCode: string | null;
  attnCheckMaxFails: number;
}

const DEFAULT_CONFIG: AppConfig = {
  prolificCompletionCode: null,
  prolificScreenOutCode: null,
  attnCheckMaxFails: 0,
};

export async function fetchAppConfig(): Promise<AppConfig> {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) return DEFAULT_CONFIG;
    const json = await res.json();
    return { ...DEFAULT_CONFIG, ...json } as AppConfig;
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function saveSession(
  sessionId: string,
  coreTask?: string,
  workflow?: { nodes: unknown[]; edges: unknown[] },
  messages?: Message[],
  extra?: Record<string, unknown>,
): Promise<void> {
  // Only include positional fields if provided — lets newer callers (e.g. the
  // task-only flow) drop coreTask/workflow/messages from the saved JSON.
  const body: Record<string, unknown> = { sessionId, ...(extra ?? {}) };
  if (coreTask !== undefined) body.coreTask = coreTask;
  if (workflow !== undefined) body.workflow = workflow;
  if (messages !== undefined) body.messages = messages;
  await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Persist a screen-out keyed on Prolific PID so a refresh can't reset it.
export async function recordScreenOut(
  pid: string,
  sessionId: string,
  reason: string,
): Promise<void> {
  await fetch('/api/screen-out', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pid, sessionId, reason }),
  });
}

// Check on app mount whether a Prolific PID has already been screened out.
export async function checkScreenStatus(
  pid: string,
): Promise<{ screenedOut: boolean; reason?: string; at?: string }> {
  try {
    const res = await fetch(`/api/screen-status?pid=${encodeURIComponent(pid)}`);
    if (!res.ok) return { screenedOut: false };
    return await res.json();
  } catch {
    return { screenedOut: false };
  }
}
