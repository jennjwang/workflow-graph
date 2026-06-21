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
  suggestions?: { label: string; description?: string; type?: import('../types').NodeType }[];
  proposed_task?: { id: string; label: string; description?: string; type?: import('../types').NodeType };
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
  existingChildren?: { id: string; label: string }[],
  ancestorChain?: string[],
  extra?: {
    responsibilities?: string;
    typicalWeek?: string;
    rejected?: string[];
    promptVariant?: string;
  },
): Promise<{ label: string; linkToExistingId?: string }[]> {
  const res = await fetch('/api/propose-subtasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      taskLabel,
      coreTask,
      jobTitle,
      statementClarification,
      existingNodes,
      existingChildren,
      ancestorChain,
      responsibilities: extra?.responsibilities,
      typicalWeek: extra?.typicalWeek,
      rejected: extra?.rejected ?? [],
      promptVariant: extra?.promptVariant,
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return data.subtasks ?? [];
}

export async function fetchKickoffQuestion(taskLabel: string): Promise<{ question: string; shortLabel: string }> {
  const res = await fetch('/api/kickoff-question', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskLabel }),
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return { question: data.question, shortLabel: data.shortLabel ?? taskLabel };
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
  conversation: string = '',
  minFollowups: number = 0,
): Promise<{ allCovered: boolean; followUp: string | null; skipRequested?: boolean }> {
  const res = await fetch('/api/evaluate-answer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, answer, criteria, maxFollowups, followupCount, evaluationStyle, conversation, minFollowups }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// Coverage pre-check: has the participant already said enough, earlier in the
// interview, to make this upcoming question redundant? Used to auto-skip a pass.
// Fails open to false (ask the question) so a flaky call never drops a question.
export async function checkQuestionCoverage(
  question: string,
  criteria: string[],
  conversation: string,
): Promise<boolean> {
  try {
    const res = await fetch('/api/check-coverage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, criteria, conversation }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data.covered === true;
  } catch {
    return false;
  }
}

// Dynamic phrasing for an opening interview question: a natural reworded variant
// of the canonical question. Fails open to null so the interview falls back to
// the canonical static text.
export async function fetchInterviewQuestion(
  canonicalQuestion: string,
  framingNotes: string,
  context: string = '',
): Promise<string | null> {
  try {
    const res = await fetch('/api/interview-question', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ canonicalQuestion, framingNotes, context }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.question ?? null;
  } catch {
    return null;
  }
}

// Integrated MECE generator (the only task generator): normalizes the
// interview-extracted tasks to O*NET standard, merges overlaps, and adds
// importance gap-fill — streaming one flat list over SSE.
export async function generateTasksFromInterview(
  jobTitle: string,
  typicalWeek: string,
  aiUsage: string | undefined,
  responsibilities: string | undefined,
  interviewTasks: string[],
  onTask: (name: string, meta?: { source?: 'interview' | 'gap' | 'bank'; bankId?: string; isProbe?: boolean; pi?: number | null }) => void,
  count?: number,
  participant?: string,                              // records volunteered tasks as spontaneous mentions
): Promise<void> {
  const res = await fetch('/api/generate-tasks-from-interview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobTitle, typicalWeek, aiUsage, responsibilities, interviewTasks, count, participant }),
  });
  if (!res.ok || !res.body) throw new Error(await res.text());
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
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
      if (event === 'task' && typeof data?.name === 'string')
        onTask(data.name, { source: data.source, bankId: data.bankId, isProbe: data.isProbe, pi: data.pi });
      else if (event === 'error') throw new Error(data.error ?? 'stream error');
      else if (event === 'done') return;
    }
  }
}

// Active-learning write-back: record a participant's confirm/deny for a BANK task, closing
// the loop (server.js /api/task-response → Postgres `responses` → posterior). Best-effort
// and fire-and-forget — the picker must never block or fail on it.
export async function postTaskResponse(args: {
  participant: string;
  task: string;                                    // bank task id (TaskItem.bankId)
  response: 'confirm' | 'deny';
  isProbe: boolean;                                // representative PROBE (counts toward decision) vs gated
  pi?: number | null;                              // PPI propensity fixed at issue; stored on the response for IPW
  shownStatement?: string;                         // exact label shown to this participant (identity audit)
  // Granular relevance rating when RELEVANCE_RATING_ENABLED is on. `response`
  // remains the binary (confirm = 'relevant', deny = everything else) so the
  // active-learning posterior is unaffected; this just preserves the richer label.
  relevance?: 'relevant' | 'future' | 'other-occupation' | 'not-valid' | 'unsure';
  aiExposure?: 'none' | 'low' | 'medium' | 'high' | null;
  occupation?: string;
}): Promise<void> {
  try {
    await fetch('/api/task-response', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
  } catch {
    /* best-effort; never block the participant flow on the write-back */
  }
}

// End-of-interview MERGE trigger: ask the server to fold this participant's confirmed GENERATED
// tasks into the bank (async + serialized, see taskBank.drainSession). Call once when the participant
// finishes the picker. Best-effort and fire-and-forget — the server acks immediately and merges after.
export async function drainSession(args: { participant: string; occupation?: string }): Promise<void> {
  try {
    await fetch('/api/drain-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
  } catch {
    /* best-effort; never block the participant */
  }
}

// Staging write-back for GENERATED (non-bank) tasks. A confirmed/denied generated task is parked
// server-side (generated_responses); drainSession() later merges the confirms into the bank.
// Best-effort and fire-and-forget — never blocks the participant.
export async function postGeneratedResponse(args: {
  participant: string;
  statement: string;                               // the generated task exactly as shown
  response: 'confirm' | 'deny';
  source?: 'interview' | 'gap';
  relevance?: 'relevant' | 'future' | 'other-occupation' | 'not-valid' | 'unsure';
  aiExposure?: 'none' | 'low' | 'medium' | 'high' | null;
  occupation?: string;
}): Promise<void> {
  try {
    await fetch('/api/generated-response', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
  } catch {
    /* best-effort; never block the participant flow on the write-back */
  }
}

// Extracts the work activities the participant EXPLICITLY mentioned in the
// background interview. Used to ground the upper-level generator so its output
// reflects what the participant said, not just what's typical for the role.
export async function extractInterviewTasks(
  backgroundTranscript: { field: string; question: string; answer: string; isFollowUp: boolean; timestamp: number }[],
  userProfile?: { jobTitle?: string; responsibilities?: string },
): Promise<string[]> {
  const res = await fetch('/api/extract-interview-tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backgroundTranscript, userProfile }),
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return Array.isArray(data.tasks) ? data.tasks : [];
}

// Generate O*NET-style attention-check tasks tailored to the participant's role —
// drawn from clearly unrelated occupations so a participant should always answer
// "I don't do this". Caller can request `count`; server clamps to 1–20.
export async function generateAttentionChecks(
  jobTitle: string,
  responsibilities?: string,
  typicalWeek?: string,
  count = 8,
): Promise<string[]> {
  const res = await fetch('/api/generate-attention-checks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobTitle, responsibilities, typicalWeek, count }),
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return Array.isArray(data.tasks) ? data.tasks.filter((t: unknown) => typeof t === 'string') : [];
}

export interface AiDerivedItem {
  name: string;
  kind: 'task' | 'responsibility';
}

// Generates work items (tasks OR new responsibilities) that emerged in this
// participant's job because of their AI usage. Distinct from generateTasksForCategory,
// which maps the role's broad MECE coverage.
export async function generateAiTasks(
  userProfile: { jobTitle: string; responsibilities?: string; typicalWeek?: string; aiUsage: string },
): Promise<AiDerivedItem[]> {
  const res = await fetch('/api/generate-ai-tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(userProfile),
  });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return Array.isArray(data.items) ? data.items : [];
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

export async function fetchSession(
  sessionId: string,
  externalId?: string | null,
): Promise<{ found: boolean; data?: Record<string, unknown> }> {
  try {
    const params = new URLSearchParams({ sessionId });
    if (externalId) params.set('externalId', externalId);
    const res = await fetch(`/api/session?${params.toString()}`);
    if (!res.ok) return { found: false };
    const json = await res.json();
    return json as { found: boolean; data?: Record<string, unknown> };
  } catch {
    return { found: false };
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

// Fire-and-forget save that survives page unload — `fetch` is cancelled when
// the tab closes, but `sendBeacon` is the platform's purpose-built escape
// hatch for unload-time POSTs. Returns whether the beacon was queued.
export function saveSessionBeacon(
  sessionId: string,
  extra: Record<string, unknown>,
): boolean {
  if (typeof navigator === 'undefined' || !navigator.sendBeacon) return false;
  const body = JSON.stringify({ sessionId, ...extra });
  const blob = new Blob([body], { type: 'application/json' });
  return navigator.sendBeacon('/api/session', blob);
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
