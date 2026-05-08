import { Message, GraphUpdate, UserProfile } from '../types';

export interface Suggestion {
  label: string;
  type: 'task' | 'decision' | 'branch';
}

export interface SuggestionSet {
  prompt: string | null;
  items: Suggestion[];
}

export async function sendChatMessage(
  messages: Message[],
  coreTask: string,
  nodes: { id: string; type: string; label: string }[],
  skipSuggestions = false,
  userProfile?: UserProfile | null,
  selectedTasks?: string[]
): Promise<{ message: string; graphUpdates: GraphUpdate[]; suggestions: SuggestionSet | null }> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, coreTask, nodes, skipSuggestions, userProfile, selectedTasks }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function evaluateAnswer(
  question: string,
  answer: string,
  criteria: string[],
  maxFollowups: number,
  followupCount: number
): Promise<{ allCovered: boolean; followUp: string | null }> {
  const res = await fetch('/api/evaluate-answer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, answer, criteria, maxFollowups, followupCount }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function generateTaskBatch(
  jobTitle: string,
  tenure: string,
  typicalWeek: string,
  batchIndex: number,
  priorTasks: string[]
): Promise<{ tasks: { name: string }[]; has_more: boolean }> {
  const res = await fetch('/api/generate-tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobTitle, tenure, typicalWeek, batchIndex, priorTasks }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
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

export async function saveSession(
  sessionId: string,
  coreTask: string,
  workflow: { nodes: unknown[]; edges: unknown[] },
  messages: Message[]
): Promise<void> {
  await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, coreTask, workflow, messages }),
  });
}
