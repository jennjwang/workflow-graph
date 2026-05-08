# Workflow Graph — Interview & Mapping Tool

A 3-phase web app that interviews a participant about their job, surfaces a task inventory, and then maps their workflows as a directed graph using an AI-guided conversation.

## Quick Start

```bash
npm run dev        # starts Vite (frontend) + Express (backend) concurrently
```

- Frontend: http://localhost:5173  
- API server: http://localhost:3001  
- Requires `OPENAI_API_KEY` in `.env`

---

## Phase Overview

| Phase | Route key | Component | What it does |
|-------|-----------|-----------|--------------|
| 1 | `background` | `BackgroundInterview` | 3 Typeform-style questions (title, tenure, typical week). AI evaluates coverage and asks one follow-up per question if criteria are unmet. |
| 2 | `task-selection` | `TaskSelection` | GPT generates a categorized task list from the Phase 1 answers. Participant selects all tasks that apply. |
| 3 | `workflow` | `InterviewTypeform` | AI-guided conversation that maps selected tasks as a directed graph. Map panel is hidden by default; toggled via "View map →". |

---

## File Map

### Entry & Routing
| File | Role |
|------|------|
| `src/main.tsx` | React root mount |
| `src/App.tsx` | Top-level phase router — renders the right component based on `store.phase` |
| `src/index.css` | Tailwind base + `html/body/#root { height: 100% }` |

### Components
| File | Role |
|------|------|
| `src/components/BackgroundInterview.tsx` | **Phase 1.** Three sequential questions with mic-record-then-transcribe or type input. After each answer, calls `/api/evaluate-answer` to check SparkMe coverage criteria; asks one AI-generated follow-up if needed. On completion, calls `/api/generate-tasks` and transitions to Phase 2. |
| `src/components/TaskSelection.tsx` | **Phase 2.** Renders GPT-generated task categories as a selectable grid. Live fill-bar shows % selected. "Add your own task" adds to a custom category. Proceed button transitions to Phase 3. |
| `src/components/InterviewTypeform.tsx` | **Phase 3.** Typeform-style single-question view with large mic orb or text input. Calls `/api/chat` for AI responses and suggestion cards (option A/B/C). Graph builds in real time. "View map →" toggles the canvas panel. |
| `src/components/WorkflowCanvas.tsx` | React Flow canvas. Handles drag-to-reposition, click-to-add-node, inline label editing, edge creation, and node deletion. Auto-layouts via dagre; manual positions override. |
| `src/components/nodes.tsx` | Custom React Flow node renderers for `start`, `task`, and `decision` node types. Inline edit on click, delete button on hover. |
| `src/components/InterviewPanel.tsx` | _(Legacy — not used in current routing. Old chat-style panel.)_ |
| `src/components/SetupScreen.tsx` | _(Legacy — not used in current routing. Old task-entry screen.)_ |

### State
| File | Role |
|------|------|
| `src/store.ts` | Single Zustand store for all phases. Holds `phase`, `userProfile`, `taskCategories`, `selectedTasks`, graph `nodes`/`edges`, chat `messages`, and `isLoading`. All mutations are store actions. |
| `src/types.ts` | Shared TypeScript types: `Phase`, `UserProfile`, `TaskCategory`, `NodeType`, `WorkflowNodeData`, `Message`, `GraphUpdate`. |

### API Client
| File | Role |
|------|------|
| `src/lib/api.ts` | All `fetch` calls to the Express backend: `sendChatMessage`, `evaluateAnswer`, `generateTaskList`, `transcribeAudio`, `saveSession`. |
| `src/lib/layout.ts` | Dagre auto-layout helper. Takes nodes + edges + manual overrides, returns repositioned nodes. |

### Backend
| File | Role |
|------|------|
| `server.js` | Express server. All API endpoints (see below). Uses OpenAI SDK with `gpt-4o-mini` by default (override with `MODEL` env var). Saves sessions to `sessions/` as JSON. |

---

## API Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /api/chat` | Main Phase 3 conversation turn. Runs an agentic tool-use loop with `add_node`, `add_edge`, and `suggest_nodes` tools. Returns `{ message, graphUpdates, suggestions }`. Accepts `userProfile` + `selectedTasks` to personalize the system prompt. |
| `POST /api/evaluate-answer` | Phase 1 coverage check. Given a question, answer, and criteria list, returns `{ allCovered, followUp }`. Follow-up is null if coverage is satisfied or follow-up budget (`maxFollowups`) is exhausted. |
| `POST /api/generate-tasks` | Phase 2 task generation. Given `jobTitle`, `tenure`, `typicalWeek`, returns `{ categories: [{ category, tasks[] }] }` using JSON mode. |
| `POST /api/transcribe` | Whisper transcription. Accepts base64 audio, writes to a temp file, calls `whisper-1`, returns `{ text }`. Body limit is 25mb. |
| `POST /api/session` | Persists a session to `sessions/<sessionId>.json`. |

---

## Key Design Decisions

**Coverage criteria (Phase 1)** are taken from SparkMe's `topics_intake.json`:
- Q1 (title + company): role, industry, and company context must be clear — 1 follow-up allowed.
- Q2 (tenure): any duration answer is accepted immediately — **0 follow-ups** (SparkMe rule: never probe duration).
- Q3 (typical week): ≥2 activities + 1 concrete task — 1 follow-up allowed.

**Map is hidden during interview.** It only becomes accessible via "View map →" once nodes start appearing, keeping the participant focused on conversation.

**Audio recording** uses `MediaRecorder` with a 250ms timeslice (ensures `ondataavailable` fires reliably across browsers), writes to a temp file server-side, and passes a read stream to Whisper — matching SparkMe's pattern.

**Graph AI tools** (`add_node`, `add_edge`, `suggest_nodes`) run in a server-side agentic loop so the model can call multiple tools before returning the final text response.

---

## Data Flow

```
Phase 1: BackgroundInterview
  → /api/evaluate-answer  (per question, up to maxFollowups times)
  → /api/generate-tasks   (on completion)
  → store: userProfile, taskCategories

Phase 2: TaskSelection
  → store: selectedTasks

Phase 3: InterviewTypeform
  → /api/chat             (each turn, with userProfile + selectedTasks in system prompt)
  → store: messages, nodes, edges
  → /api/session          (auto-save after each graph update)
```

---

## Dev Shortcuts

`src/store.ts` initial state can be set to skip to any phase for faster iteration:
- Change `phase: 'background'` to `phase: 'workflow'` and prefill `userProfile`, `selectedTasks`, and `coreTask` to jump straight to Phase 3 without going through Phases 1–2.
- Reset to `phase: 'background'` and clear the prefilled values to test the full flow.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | required | OpenAI API key |
| `MODEL` | `gpt-4o-mini` | OpenAI model for chat + task generation |
| `PORT` | `3001` | Express server port |
