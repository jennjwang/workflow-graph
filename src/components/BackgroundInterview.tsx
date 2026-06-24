import { Fragment, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useWorkflowStore } from "../store";
import {
  evaluateAnswer,
  checkQuestionCoverage,
  fetchInterviewQuestion,
  transcribeAudio,
  gapProbe,
  GapArea,
} from "../lib/api";
import { UserProfile } from "../types";

type RecordState = "idle" | "recording" | "transcribing";

// Coverage criteria and follow-up rules per question, taken from SparkMe topics_intake.json
const QUESTIONS: {
  field: keyof UserProfile;
  text: string;
  placeholder: string;
  criteria: string[];
  maxFollowups: number;
  // Minimum follow-ups to ALWAYS ask, even if coverage criteria are already met
  minFollowups?: number;
  // A fixed catch-all question always asked once, after the follow-ups
  closingQuestion?: string;
  evaluationStyle?: "lenient" | "strict";
  // Constraints the dynamic question rephrasing MUST preserve
  framingNotes?: string;
  // When true, show the canonical text VERBATIM — skip the per-session LLM
  // rephrasing (used where a precise, concrete wording matters and rephrasing
  // tends to drift vague).
  staticText?: boolean;
  // When true, feed the conversation so far to the rephraser so the question is
  // TAILORED to the participant's role/work instead of reading generically.
  contextual?: boolean;
  // Static topic-transition lead-in shown above the question when entering this
  // pass, to ease the jump between topics. (Static, not answer-reflecting —
  // reactive lead-ins were tried and rejected.)
  transition?: string;
}[] = [
  {
    field: "jobTitle",
    text: "To start, what is your current role, and how long have you been in this job?",
    framingNotes:
      "This is the opening question. Ask their current role/job title AND roughly how long they've been in it. Keep it warm and light.",
    placeholder: "Your role + roughly how long you've been doing it",
    criteria: [
      "The participant has named their job title or role (e.g. 'nurse', 'software engineer', 'PhD student'). Any brief mention is sufficient — do not probe for more detail.",
      "It is clear what field or industry the participant works in.",
      "The participant has indicated approximately how long they have been in this specific role or job — a rough range is sufficient (e.g. 'a few years', '10 years', 'just started'). Any single duration answer satisfies this criterion — even vague ones like 'almost 2 years' or 'a couple years'. IMPORTANT: a tenure cue embedded in how they describe their role ALSO satisfies this — e.g. 'first-year PhD student', 'second-year resident', 'new grad', 'just started', 'trainee', 'incoming analyst'. 'First-year CS PhD' already tells you they're in their first year, so duration IS covered — do NOT ask how long they've been in the role. If asking, ask about THIS ROLE specifically (e.g. 'how long have you been in this role?') — do NOT ask about the broader field, discipline, or career category. Once answered, do NOT follow up on duration in any way. ❌ Do NOT ask 'does that feel closer to X or Y?', 'is that on the shorter or longer end?', or any clarifying or reframing question about the duration. Accept the answer as-is and move on immediately.",
    ],
    maxFollowups: 1,
  },
  {
    field: "responsibilities",
    text: "What are your primary responsibilities at work?",
    framingNotes:
      "Ask what their main responsibilities are — the parts of the job they're responsible for, NOT the day-to-day activities (that's a later question). Keep the word 'responsibilities'; do NOT swap in 'duties', 'tasks', or 'key areas'. Use plain wording that fits ANY job; do NOT use managerial verbs like 'oversee', 'manage', 'lead', or 'in charge of'.",
    placeholder: "What you own or are accountable for",
    criteria: [
      "FLOOR — the participant has named at least one primary responsibility or area they own (e.g. 'I own the team's product specs', 'I'm responsible for patient care'). If they named NONE ('a bit of everything', 'various things'), follow up asking what they're mainly responsible for.",
      "STAY AT OWNERSHIP ALTITUDE — this question maps WHAT they own, not how they spend their time. Do NOT drill into the specific tasks or activities under a responsibility — a later question ('a typical week') covers that. A responsibility named only at a high level is FINE here; do NOT treat missing task detail as uncovered. Do NOT ask whether there are OTHER areas they're responsible for — breadth is gathered by the later task passes, not here.",
    ],
    maxFollowups: 2,
    minFollowups: 0,
  },
  {
    field: "typicalWeek",
    text: "Walk me through a typical week. What are the recurring tasks you do?",
    transition: "Next, let's think about your week as it usually goes.",
    framingNotes:
      "Ask them to walk through a typical week and name the recurring tasks they regularly do. Frame around what's TYPICAL and RECURRING — the things they do on a regular basis — NOT a specific recent week. You MAY invite them to walk through it loosely, but do NOT force a rigid hour-by-hour or day-by-day breakdown. KEEP the encouragement to be as specific as possible about the actual tasks they do.",
    placeholder:
      "The tasks you do regularly — meetings, deliverables, the day-to-day",
    criteria: [
      "FLOOR — the participant has named at least one real recurring activity or task. If they named NO actual activity at all ('the usual', 'just work stuff', 'hard to say'), follow up asking what they regularly do in a typical week.",
      "BREADTH — if they named only ONE activity or area (e.g. 'mostly building an app', 'just seeing patients'), follow up ONCE: briefly ACKNOWLEDGE it, then ask whether there are other tasks or activities they also do regularly. Do NOT push for more detail on that one activity. If they named several distinct activities, breadth is covered.",
      "SUBSTANCE — the answer must give a concrete sense of the TASKS the work involves, not just generic activity labels. A bare list — e.g. 'I have some zooms and a standup, otherwise I write proposals and do research' — names activities but not the actual tasks within them. When a central activity is named only as a bare label, it is NOT covered — follow up: warmly pick the SINGLE most central still-vague activity and ask what they have to DO for it — the smaller tasks it breaks into — NOT its topic or which specific one (e.g. they say 'I write proposals' → 'What do you need to do to put a proposal together?'; 'I do research' → 'What do you actually have to do when you work on that?'). Probe ONE thread per turn — never interrogate every item at once, never sound skeptical. If the central activities already carry concrete task detail, this is covered.",
      "DEEPEN THE CENTER — if ONE activity clearly DOMINATES their week (e.g. a developer who mostly programs, a nurse who mostly sees patients, a teacher who mostly teaches), do NOT settle for the overall workflow of it and move on — that under-serves a concentrated role. Spend follow-ups drilling into the DISTINCT KINDS of work within that core activity before broadening to smaller activities (e.g. for a developer: 'beyond the overall flow, what are the different kinds of programming work that come up for you?' → building features, debugging, writing tests, refactoring). KINDS of work are tasks; this is not content-fishing. Only once the core is richly covered should you rotate to other, smaller activities they named. If no single activity dominates, or the core is already richly detailed, this is covered.",
      "RESPONSIBILITY COVERAGE — earlier in the conversation the participant described their primary responsibilities. If any responsibility or area they named does NOT clearly map to a task they mentioned, it is NOT fully covered: follow up ONCE, warmly, asking whether they regularly do anything on that responsibility (e.g. earlier they said they're responsible for hiring but never mentioned it → 'Earlier you mentioned you're responsible for hiring — is that something you work on in a typical week?'). Probe ONE uncovered responsibility per turn. If they didn't describe their responsibilities, or every responsibility already maps to something they mentioned, this is covered.",
    ],
    maxFollowups: 4,
    minFollowups: 2,
  },
  {
    field: "outputs",
    text: "What do you produce or deliver in your work — like reports, documents, code, or designs?",
    transition: "Let's shift from what you do to what you end up with.",
    contextual: true,
    framingNotes:
      "Elicit tasks via the participant's OUTPUTS — the tangible things they produce, update, approve, send, maintain, or deliver. Phrase it SPECIFICALLY and NATURALLY for THIS participant's role and the work they've described, with a couple of example artifacts that actually fit them — e.g. for a developer 'what do you usually ship or hand off?', for a lawyer 'what do you draft or file?', for an analyst 'what reports or analyses do you put out?' — WITHOUT naming specific things they haven't mentioned. Do NOT use the word 'actually', do NOT read a generic list of nouns, and do NOT include odd-fitting examples like 'a decision' for roles where that isn't a produced artifact. The point is to surface tangible things they'd skip when narrating activities, then decompose each into the work behind it.",
    placeholder: "What you produce, approve, send, or keep up to date",
    criteria: [
      "FLOOR — the participant has named at least one concrete output or artifact they own (e.g. 'the weekly sales report', 'patient charts', 'the onboarding deck'). If they named NONE ('not really anything', 'hard to say'), follow up warmly asking what they produce, maintain, or deliver.",
      "DELIVERY & UPKEEP (not the building) — a 'typical week' question already covers how they DO the core work, so do NOT re-ask how they build an output. Here, focus on the FINISHING and DELIVERY side: what they do to get an output READY and OUT, or to keep it up to date — checking/reviewing, formatting/packaging, getting approval/sign-off, sending/publishing, and ongoing maintenance. Follow up ONCE on the SINGLE most central output (e.g. 'the monthly board deck' → 'What do you do to get it ready before it goes out?'; 'code' → 'Once it's written, what do you do to get it ready to hand off?'). If that finishing/upkeep work is already clear, or it would just repeat what they said about building it, this is covered. Probe ONE output per turn, warmly.",
      "BREADTH — if they named only ONE output, follow up ONCE: briefly ACKNOWLEDGE it, then ask whether there are other things they produce, maintain, or are accountable for. If they named several distinct outputs, breadth is covered.",
    ],
    maxFollowups: 2,
    minFollowups: 0,
  },
  {
    field: "stakeholders",
    text: "Who do you do your work for or with — the people, teams, or clients you deal with?",
    transition: "Now let's turn to the people side of your work.",
    contextual: true,
    framingNotes:
      "The GOAL of this pass is to surface the participant's RELATIONAL and COMMUNICATION tasks — the interpersonal work that involves other people: running or attending meetings, writing status updates, reporting to someone, coordinating handoffs, giving and getting feedback, reviewing others' work, escalating issues, negotiating, answering questions, onboarding or mentoring, presenting, keeping people aligned. WHO they work with is just the entry point; the aim is the TASKS those relationships carry, NOT an org chart. Phrase the opener SPECIFICALLY for THIS participant's role — a generic 'who do you work with?' is too broad — using their role to make it concrete (e.g. for a nurse, who they work alongside on a shift and who they care for; for a freelancer, which clients and collaborators), WITHOUT naming specific people they haven't mentioned.",
    placeholder: "Who you work for or with — teammates, clients, other teams",
    criteria: [
      "FLOOR — the participant has named at least one person, team, role, or outside party they do work for or with (e.g. 'my manager', 'the sales team', 'patients', 'external vendors'). If they named NONE ('I mostly work alone', 'no one really'), follow up warmly asking who they work for or with, even occasionally.",
      "RELATIONAL TASKS (PRIORITIZE THIS) — the point is to surface the COMMUNICATION / INTERPERSONAL tasks each main relationship carries: what they communicate, coordinate, hand off, report, present, review, escalate, or give/get feedback on. When a stakeholder is named only as a bare label, follow up with a CLEAR, plain question about that relationship — e.g. 'How do you usually interact with them?', 'What do you usually go to them for, or do for them?', 'What do you usually work on with them?'. Keep it concrete and easy to answer; do NOT use clunky phrasings like 'what's the back-and-forth with them?'. Pick the SINGLE most central relationship. Aim to draw out relational tasks (running the weekly sync, writing the client update, reviewing PRs, escalating blockers) — but do NOT lead by naming a specific task they haven't mentioned; keep it open for THEM to fill. Probe ONE relationship per turn, never skeptically. If the main relationships already carry concrete relational tasks, this is covered.",
      "BREADTH (secondary, use sparingly) — only if they named just ONE party and others clearly exist may you ask once who else. Do NOT reflexively ask 'who else do you work with?' once they've given a reasonable set — that usually just gets 'not really' and no new task. If they named several parties, breadth is covered.",
    ],
    maxFollowups: 1,
    minFollowups: 0,
  },
];

// Closing thank-you shown after the last question, before task selection
const OUTRO_TEXT =
  "Great! From this quick interview, we'll generate a list of tasks for you to review and refine next.";

// The catch-all is asked ONCE at the very end, as a final step before the outro —
// independent of any single question, so it always runs even when the last
// question(s) were auto- or manually skipped.
const FINAL_CATCHALL =
  "Final question: if someone shadowed you for two weeks, what tasks would they see that we haven't named yet?";

// GAP PROBE: after the static passes + catch-all, the server assesses what the
// participant has mentioned, finds substantive role-specific coverage gaps, and
// returns up to GAP_MAX_AREAS open, non-leading questions to ask before the outro.
const GAP_MAX_AREAS = 3;

// The static passes + final catch-all fill the progress bar up to this fraction;
// the rest is reserved for the gap-probe pass (whose length isn't known upfront).
const CORE_PROGRESS_MAX = 0.9;

// AUTO skip (#3): questions eligible to be skipped automatically when earlier
// answers already cover their criteria. The opening role question and the
// responsibilities question always run.
const AUTO_SKIP_FIELDS = new Set<string>([
  "typicalWeek",
  "outputs",
  "stakeholders",
]);

// Reveals text one word at a time, each word rising and fading in (staggered).
// Calls onDone once the last word has finished animating.
const POP_START = 30;
const POP_STAGGER = 58;
const POP_FADE = 600;
function PopInText({ text, onDone }: { text: string; onDone?: () => void }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const start = setTimeout(() => setShown(true), POP_START);
    const wordCount = text.split(" ").length;
    const total = POP_START + (wordCount - 1) * POP_STAGGER + POP_FADE;
    const done = onDone ? setTimeout(onDone, total) : undefined;
    return () => {
      clearTimeout(start);
      if (done) clearTimeout(done);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      {text.split(" ").map((word, i) => (
        <Fragment key={i}>
          <span
            className="inline-block"
            style={{
              opacity: shown ? 1 : 0,
              transform: shown ? "translateY(0)" : "translateY(10px)",
              transition: `opacity ${POP_FADE}ms ease, transform ${POP_FADE}ms ease`,
              transitionDelay: `${i * POP_STAGGER}ms`,
            }}
          >
            {word}
          </span>{" "}
        </Fragment>
      ))}
    </>
  );
}

function MicOrb({
  state,
  onToggle,
  disabled,
}: {
  state: RecordState;
  onToggle: () => void;
  disabled: boolean;
}) {
  const isRecording = state === "recording";
  const isTranscribing = state === "transcribing";
  return (
    <div className="flex flex-col items-center gap-3 select-none">
      <div className="relative flex items-center justify-center">
        {isRecording && (
          <>
            <span className="absolute w-36 h-36 rounded-full bg-indigo-100 animate-ping opacity-30" />
            <span className="absolute w-28 h-28 rounded-full bg-indigo-100 animate-ping opacity-50 [animation-delay:250ms]" />
          </>
        )}
        <button
          type="button"
          onClick={onToggle}
          disabled={disabled || isTranscribing}
          className={`relative z-10 w-20 h-20 rounded-full flex items-center justify-center transition-all duration-200
            ${
              isRecording
                ? "bg-red-500 shadow-lg shadow-red-200 scale-105"
                : isTranscribing
                  ? "bg-indigo-100 cursor-not-allowed"
                  : "bg-indigo-50 hover:bg-indigo-100 hover:scale-105 active:scale-95 shadow-sm"
            }
            disabled:opacity-50`}
        >
          {isTranscribing ? (
            <div className="flex items-center justify-center gap-[3px] h-7">
              {[0, 120, 240, 360, 480].map((delay, i) => (
                <span
                  key={i}
                  className="w-[3px] h-6 bg-indigo-500 rounded-full animate-waveBar"
                  style={{ animationDelay: `${delay}ms` }}
                />
              ))}
            </div>
          ) : isRecording ? (
            <svg
              className="w-6 h-6 text-white"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          ) : (
            <svg
              className="w-8 h-8 text-indigo-600"
              viewBox="0 0 24 24"
              fill="none"
            >
              <rect
                x="9"
                y="2"
                width="6"
                height="12"
                rx="3"
                fill="currentColor"
              />
              <path
                d="M5 10a7 7 0 0 0 14 0"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                fill="none"
              />
              <line
                x1="12"
                y1="19"
                x2="12"
                y2="22"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
              <line
                x1="9"
                y1="22"
                x2="15"
                y2="22"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          )}
        </button>
      </div>
      <span
        className={`text-sm font-medium tracking-wide transition-colors ${
          isRecording
            ? "text-red-500"
            : isTranscribing
              ? "text-indigo-400"
              : "text-indigo-600"
        }`}
      >
        {isRecording
          ? "Recording — click to stop"
          : isTranscribing
            ? "Transcribing…"
            : "Start Recording"}
      </span>
    </div>
  );
}

// Desktop (mouse/trackpad) benefits from auto-focusing the answer box so the
// participant can just start typing. On touch devices, auto-focus instead pops
// the on-screen keyboard and scrolls the viewport on every question transition
// (the textarea unmounts during evaluation and remounts for the next question),
// which feels jarring. Gate auto-focus to fine pointers so mobile users open
// the keyboard by tapping the field themselves. User-initiated focuses (the
// "Prefer to type?" toggle, post-transcription edit) are intentionally left on.
const AUTOFOCUS_ANSWER =
  typeof window !== "undefined" &&
  !!window.matchMedia &&
  window.matchMedia("(pointer: fine)").matches;

export function BackgroundInterview() {
  const { setUserProfile, setPhase, addBackgroundTurn } = useWorkflowStore(
    useShallow((s) => ({
      setUserProfile: s.setUserProfile,
      setPhase: s.setPhase,
      addBackgroundTurn: s.addBackgroundTurn,
    })),
  );

  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<keyof UserProfile, string>>({
    responsibilities: "",
    jobTitle: "",
    typicalWeek: "",
    aiUsage: "",
    outputs: "",
    stakeholders: "",
    tools: "",
    invisibleWork: "",
  });

  // Follow-up state for current question
  const [followUpQ, setFollowUpQ] = useState<string | null>(null);
  const [followUpCount, setFollowUpCount] = useState(0);
  const [accumulatedAnswer, setAccumulatedAnswer] = useState("");
  // Full interview conversation (every Q/A across all questions), so the
  // evaluator asks follow-ups as a natural continuation, not a templated probe.
  const convoRef = useRef<{ q: string; a: string }[]>([]);
  // Final catch-all state (asked once at the very end, before the outro)
  const [isClosingActive, setIsClosingActive] = useState(false);

  // Gap-probe state: dynamic, role-specific follow-up questions asked AFTER the
  // catch-all (computed live from what they've said). Reuses followUpQ for display.
  const [gapAreas, setGapAreas] = useState<GapArea[]>([]);
  const [gapIdx, setGapIdx] = useState(0);
  const [isGapActive, setIsGapActive] = useState(false);

  // Live (LLM-generated) phrasing for the current question; falls back to the
  // question's canonical static text on null.
  const [dynamicQuestion, setDynamicQuestion] = useState<string | null>(null);

  const [input, setInput] = useState("");
  const [showTextInput, setShowTextInput] = useState(false);
  const [recordState, setRecordState] = useState<RecordState>("idle");
  const [recordTranscribeError, setRecordTranscribeError] = useState<
    string | null
  >(null);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [questionVisible, setQuestionVisible] = useState(true);

  // Closing thank-you screen, shown after the last question
  const [showOutro, setShowOutro] = useState(false);
  const [outroButtonReady, setOutroButtonReady] = useState(false);

  const finishOutro = () => {
    setIsSubmitting(true);
    setPhase("task-selection");
  };

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  // Size the auto-grow textarea to its content — or, when empty, to its
  // (possibly wrapping) placeholder, so a multi-line placeholder is never
  // clipped on narrow/mobile widths where the hint text wraps. Reads the
  // placeholder straight off the DOM, so it stays one line on wider screens
  // where it fits without forcing a fixed taller box.
  const autosizeInput = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    // scrollHeight is content+padding only; with box-border the set height must
    // add the border so the content area isn't clipped by the border width.
    const borderY = el.offsetHeight - el.clientHeight;
    const fit = (content: number) => `${content + borderY}px`;
    if (el.value) {
      el.style.height = fit(el.scrollHeight);
    } else {
      const ph = el.placeholder;
      el.value = ph;
      el.style.height = fit(el.scrollHeight);
      el.value = "";
    }
  };

  const q = QUESTIONS[step];
  // What's visually shown — live phrasing when available, else canonical text
  const displayQuestion = followUpQ ?? dynamicQuestion ?? q.text;
  const isFollowUpActive = followUpQ !== null;
  const placeholderText = isFollowUpActive ? "Your answer…" : q.placeholder;

  // Continuous progress (0–1) for the header bar. Robust to auto-skips, which
  // would make a fixed "Topic X of N" misleading: the bar just advances. The
  // active question gets half credit; a follow-up or the final catch-all pushes
  // it the rest of the way toward the next step. The static passes + catch-all
  // fill up to CORE_PROGRESS_MAX; the remainder is reserved for the (dynamic)
  // gap-probe pass so the bar isn't pinned at 100% while gap questions remain.
  const progress = showOutro
    ? 1
    : isGapActive
      ? CORE_PROGRESS_MAX +
        (1 - CORE_PROGRESS_MAX) *
          Math.min(1, (gapIdx + 0.5) / Math.max(1, gapAreas.length))
      : CORE_PROGRESS_MAX *
        Math.min(
          1,
          (step + (isFollowUpActive || isClosingActive ? 1 : 0.5)) /
            QUESTIONS.length,
        );

  // Re-size the input whenever its content, its placeholder (question/follow-up
  // change), or its visibility (voice↔text toggle, mount) changes.
  useEffect(() => {
    autosizeInput();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, placeholderText, showTextInput]);

  // Fetch the live reworded phrasing for a question index, racing a timeout so
  // a slow call never stalls the flow — fall back to the canonical static text.
  const loadDynamic = async (index: number) => {
    const target = QUESTIONS[index];
    // Static questions are shown verbatim — no rephrasing.
    if (target.staticText) {
      setDynamicQuestion(null);
      return;
    }
    // Contextual questions get the conversation so far so the rephraser can
    // tailor them to the participant's role/work.
    const context = target.contextual
      ? convoRef.current
          .map((t) => `Interviewer: ${t.q}\nParticipant: ${t.a}`)
          .join("\n")
      : "";
    const question = await Promise.race([
      fetchInterviewQuestion(target.text, target.framingNotes ?? "", context),
      new Promise<string | null>((r) => setTimeout(() => r(null), 1600)),
    ]);
    setDynamicQuestion(question);
  };

  // The opening question is shown verbatim (canonical static text) so it reads
  // the same for every participant — no dynamic rephrasing on question 0.
  // Later questions still get their reworded phrasing via advanceStep.

  const advanceStep = async (finalAnswer: string) => {
    const newAnswers = { ...answers, [q.field]: finalAnswer };
    setAnswers(newAnswers);
    setInput("");
    setShowTextInput(false);

    // Fade the CURRENT text out FIRST; only swap to the next screen once it's
    // invisible, so stale text (e.g. the old follow-up) never flashes mid-fade.
    setQuestionVisible(false);
    // Keep the loading indicator up across the whole gap (coverage checks +
    // rephrasing can take a couple of seconds) so the screen never sits blank —
    // it's turned off only once the next question is ready to show.
    setIsEvaluating(true);

    const resetQuestionState = () => {
      setFollowUpQ(null);
      setFollowUpCount(0);
      setAccumulatedAnswer("");
      setIsClosingActive(false);
    };

    // Pick the next question, AUTO-SKIPPING any eligible upcoming question whose
    // criteria are already satisfied by what's been said so far (#3).
    const conversation = convoRef.current
      .map((t) => `Interviewer: ${t.q}\nParticipant: ${t.a}`)
      .join("\n");
    let nextIndex = step + 1;
    while (nextIndex < QUESTIONS.length) {
      const next = QUESTIONS[nextIndex];
      if (!AUTO_SKIP_FIELDS.has(next.field)) break;
      const covered = await checkQuestionCoverage(
        next.text,
        next.criteria,
        conversation,
      );
      if (!covered) break;
      // Record the auto-skip so analysts can see it, but DON'T push it to
      // convoRef — it must not pollute later coverage checks or task extraction.
      addBackgroundTurn({
        field: next.field,
        question: next.text,
        answer: "(auto-skipped — already covered earlier)",
        isFollowUp: false,
        timestamp: Date.now(),
      });
      nextIndex += 1;
    }

    if (nextIndex < QUESTIONS.length) {
      // Wait out the fade (matches the 250ms CSS) and load the next question's
      // phrasing, THEN swap content + fade back in.
      await Promise.all([
        loadDynamic(nextIndex),
        new Promise((r) => setTimeout(r, 260)),
      ]);
      resetQuestionState();
      setStep(nextIndex);
      setIsEvaluating(false);
      setQuestionVisible(true);
    } else {
      // Exhausted all questions (some may have been skipped). Persist the
      // profile, then ALWAYS ask the catch-all once before the outro — it's the
      // one step that runs no matter what. Its answer is captured in the
      // transcript (addBackgroundTurn), not in a profile field, so it can't
      // overwrite the last question's answer.
      setUserProfile(newAnswers as UserProfile);
      setIsClosingActive(true);
      setFollowUpCount(0);
      setAccumulatedAnswer("");
      await new Promise((r) => setTimeout(r, 260));
      setFollowUpQ(FINAL_CATCHALL);
      setIsEvaluating(false);
      setQuestionVisible(true);
    }
  };

  // After the catch-all, probe for substantive coverage gaps and ask them as
  // open follow-ups before the outro. Computed live from the transcript so far
  // (which already includes the catch-all answer). Fails open: no gaps → finish.
  const startGapProbe = async () => {
    setInput("");
    setShowTextInput(false);
    setQuestionVisible(false);
    setIsEvaluating(true);
    setIsClosingActive(false);

    const { backgroundTranscript, userProfile } = useWorkflowStore.getState();
    const areas = await gapProbe(backgroundTranscript, userProfile, GAP_MAX_AREAS);

    if (!areas.length) {
      await finishInterview();
      return;
    }
    setGapAreas(areas);
    setGapIdx(0);
    setIsGapActive(true);
    setFollowUpCount(0);
    setAccumulatedAnswer("");
    await new Promise((r) => setTimeout(r, 260));
    setFollowUpQ(areas[0].question);
    setIsEvaluating(false);
    setQuestionVisible(true);
  };

  // Advance to the next gap question, or finish once they're exhausted.
  const advanceGap = async () => {
    setInput("");
    setShowTextInput(false);
    const nextIdx = gapIdx + 1;
    setQuestionVisible(false);
    setIsEvaluating(true);
    if (nextIdx < gapAreas.length) {
      await new Promise((r) => setTimeout(r, 260));
      setGapIdx(nextIdx);
      setFollowUpQ(gapAreas[nextIdx].question);
      setIsEvaluating(false);
      setQuestionVisible(true);
    } else {
      setIsGapActive(false);
      setIsEvaluating(false);
      await finishInterview();
    }
  };

  // The catch-all is the final step: any answer (or a skip) ends the interview.
  const finishInterview = async () => {
    setInput("");
    setShowTextInput(false);
    setQuestionVisible(false);
    await new Promise((r) => setTimeout(r, 260));
    setFollowUpQ(null);
    setFollowUpCount(0);
    setAccumulatedAnswer("");
    setIsClosingActive(false);
    setIsGapActive(false);
    setShowOutro(true);
    setQuestionVisible(true);
  };

  const advance = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || isEvaluating) return;

    setInput("");
    setShowTextInput(false);

    // Record this turn. Gap-probe answers are tagged with a distinct field so
    // analysts (and the final extraction) can tell them apart from pass answers.
    addBackgroundTurn({
      field: isGapActive ? "gapProbe" : q.field,
      question: displayQuestion,
      answer: trimmed,
      isFollowUp: isGapActive ? false : isFollowUpActive,
      timestamp: Date.now(),
    });
    // Append to the running conversation transcript (what was actually asked + said)
    convoRef.current.push({ q: displayQuestion, a: trimmed });

    // They just answered a gap-probe question — move to the next gap, or finish.
    if (isGapActive) {
      await advanceGap();
      return;
    }

    // Build up the full answer context for coverage evaluation
    const combined = isFollowUpActive
      ? `${accumulatedAnswer}\n${trimmed}`
      : trimmed;

    // They just answered the final catch-all — now probe for coverage gaps
    // (which, if any, run before the outro), else finish.
    if (isClosingActive) {
      await startGapProbe();
      return;
    }

    const newFollowUpCount = isFollowUpActive
      ? followUpCount + 1
      : followUpCount;

    // If this question has follow-up capacity remaining, evaluate coverage
    if (newFollowUpCount < q.maxFollowups) {
      setIsEvaluating(true);
      try {
        const conversation = convoRef.current
          .map((t) => `Interviewer: ${t.q}\nParticipant: ${t.a}`)
          .join("\n");
        const result = await evaluateAnswer(
          q.text,
          combined,
          q.criteria,
          q.maxFollowups,
          newFollowUpCount,
          q.evaluationStyle ?? "lenient",
          conversation,
          q.minFollowups ?? 0,
        );
        // MANUAL skip: the evaluator detected the participant asked to skip this
        // question. End it now — no more follow-ups for it. Keep any substance
        // from earlier in this topic; the skip turn itself is dropped. (The final
        // catch-all still runs once at the end, via advanceStep.) Leave the
        // loader ON — advanceStep keeps it up until the next question shows.
        if (result.skipRequested) {
          await advanceStep(isFollowUpActive ? accumulatedAnswer : "");
          return;
        }
        if (!result.allCovered && result.followUp) {
          // Fade the answered question out, then swap in the follow-up. Keep the
          // loader up through the fade; clear it only when the follow-up shows.
          const followUp = result.followUp;
          setAccumulatedAnswer(combined);
          setFollowUpCount(newFollowUpCount);
          setQuestionVisible(false);
          setTimeout(() => {
            setFollowUpQ(followUp);
            setIsEvaluating(false);
            setQuestionVisible(true);
          }, 260);
          return;
        }
      } catch (e) {
        console.error("Coverage evaluation failed", e);
      }
      // Loader stays ON here; advanceStep (below) carries it until the next
      // question is ready, then clears it.
    }

    // All covered (or max follow-ups reached, or evaluation failed) — advance.
    // The catch-all is no longer asked per-question; advanceStep asks it once
    // globally, after the last question, so it always runs.
    await advanceStep(combined);
  };

  const toggleRecording = async () => {
    if (recordState === "recording") {
      mediaRecorderRef.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunksRef.current = [];
      const mimeType =
        [
          "audio/webm;codecs=opus",
          "audio/webm",
          "audio/ogg;codecs=opus",
          "audio/mp4",
        ].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const chunks = audioChunksRef.current;
        if (chunks.length === 0) {
          setRecordTranscribeError("No audio captured — try again.");
          setRecordState("idle");
          return;
        }
        setRecordState("transcribing");
        try {
          const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
          const text = await transcribeAudio(blob);
          if (text.trim()) {
            setInput((prev) => (prev ? prev + " " + text : text));
            setShowTextInput(true);
            setTimeout(() => inputRef.current?.focus(), 50);
          } else {
            setRecordTranscribeError("Nothing was heard — try again.");
          }
        } catch (e) {
          console.error("Transcription failed", e);
          setRecordTranscribeError(
            "Transcription failed — try again or type your answer.",
          );
        } finally {
          setRecordState("idle");
        }
      };
      recorder.start(250); // 250ms timeslice ensures data flows reliably
      setRecordTranscribeError(null);
      setRecordState("recording");
    } catch (e) {
      console.error("Mic access denied", e);
      setRecordTranscribeError(
        "Microphone access denied — please allow mic permissions.",
      );
    }
  };

  if (isSubmitting) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-white gap-4">
        <div className="flex gap-2">
          {[0, 150, 300].map((d) => (
            <span
              key={d}
              className="w-2.5 h-2.5 bg-indigo-300 rounded-full animate-bounce"
              style={{ animationDelay: `${d}ms` }}
            />
          ))}
        </div>
        <p className="text-sm text-slate-500">Building your task list…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-white relative overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-56 bg-gradient-to-b from-indigo-50/30 to-transparent pointer-events-none" />

      {/* Header with progress bar */}
      <div className="relative z-10 px-5 sm:px-8 pt-7 sm:pt-8 pb-5 shrink-0 w-full mx-auto max-w-[780px]">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-indigo-400 mb-3">
          Interview
          {!showOutro && isFollowUpActive && (
            <span className="ml-2 normal-case tracking-normal text-indigo-300">
              · follow-up
            </span>
          )}
        </p>
        <div className="h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-indigo-400 to-violet-400 transition-all duration-500 ease-out"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
      </div>

      {/* Main content */}
      <div className="relative z-10 flex-1 flex flex-col justify-center min-h-0 overflow-y-auto">
        <div className="px-5 sm:px-10 max-w-3xl mx-auto w-full">
          {/* Headline slot — intro copy or the current question (shared fade) */}
          <div
            className="mb-9 sm:mb-12 transition-all duration-250"
            style={{
              opacity: questionVisible ? 1 : 0,
              transform: questionVisible ? "translateY(0)" : "translateY(10px)",
            }}
          >
            {showOutro ? (
              <p className="text-[1.3rem] sm:text-[1.6rem] font-light text-slate-800 leading-[1.55] tracking-[-0.01em]">
                <PopInText
                  key="outro"
                  text={OUTRO_TEXT}
                  onDone={() => setOutroButtonReady(true)}
                />
              </p>
            ) : (
              <>
                {!isFollowUpActive && !isClosingActive && q.transition && (
                  <p className="text-[15px] text-indigo-400 mb-3 font-medium">
                    {q.transition}
                  </p>
                )}
                <p className="text-[1.4rem] sm:text-[1.75rem] font-light text-slate-800 leading-[1.4] sm:leading-[1.45] tracking-[-0.015em]">
                  {displayQuestion}
                </p>
              </>
            )}
          </div>

          {/* Action slot — Continue (outro) */}
          {showOutro && (
            <div
              className="mt-10 transition-all duration-500"
              style={{
                opacity: outroButtonReady ? 1 : 0,
                transform: outroButtonReady
                  ? "translateY(0)"
                  : "translateY(8px)",
                pointerEvents: outroButtonReady ? "auto" : "none",
              }}
            >
              <button
                onClick={finishOutro}
                className="inline-flex items-center gap-2 px-6 py-3 bg-indigo-600 hover:bg-indigo-700
                           text-white text-sm font-medium rounded-xl transition-all active:scale-95
                           shadow-sm shadow-indigo-200"
              >
                Continue
                <svg
                  className="w-4 h-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </button>
            </div>
          )}

          {/* Evaluating indicator */}
          {isEvaluating && (
            <div className="flex items-center gap-2 mb-8 text-sm text-slate-400">
              <div className="flex gap-1">
                {[0, 150, 300].map((d) => (
                  <span
                    key={d}
                    className="w-1.5 h-1.5 bg-indigo-300 rounded-full animate-bounce"
                    style={{ animationDelay: `${d}ms` }}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Mic orb */}
          {!showOutro && questionVisible && !showTextInput && !isEvaluating && (
            <div className="flex flex-col items-center py-4 mb-8 gap-3">
              <MicOrb
                state={recordState}
                onToggle={toggleRecording}
                disabled={isEvaluating}
              />
              {recordTranscribeError && (
                <p className="text-xs text-red-500 text-center">
                  {recordTranscribeError}
                </p>
              )}
            </div>
          )}

          {/* Text input */}
          {showTextInput && !isEvaluating && (
            <div className="space-y-3 mb-8">
              <div className="flex gap-2 items-end">
                <textarea
                  ref={inputRef}
                  rows={1}
                  className="flex-1 border border-slate-200 rounded-2xl px-5 py-3.5 text-sm text-slate-800 leading-[1.55]
                             placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-300
                             focus:border-transparent bg-white transition-colors duration-150 resize-none
                             max-h-60 overflow-y-auto"
                  placeholder={placeholderText}
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    // Auto-grow so the participant can see everything they've typed.
                    autosizeInput();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      advance(input);
                    }
                  }}
                  disabled={recordState !== "idle" || isEvaluating}
                  autoFocus={AUTOFOCUS_ANSWER}
                />
                <button
                  onClick={() => advance(input)}
                  disabled={
                    !input.trim() || recordState !== "idle" || isEvaluating
                  }
                  className="w-10 h-10 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-30 text-white
                             rounded-xl flex items-center justify-center transition-all active:scale-95
                             shadow-sm shadow-indigo-200 shrink-0"
                >
                  <svg
                    className="w-4 h-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="12" y1="19" x2="12" y2="5" />
                    <polyline points="5 12 12 5 19 12" />
                  </svg>
                </button>
              </div>
              <p className="text-[11px] text-slate-400 pl-1">
                <kbd className="bg-slate-100 px-1.5 py-0.5 rounded text-[10px] font-mono text-slate-500 mr-1">
                  Enter
                </kbd>
                to continue ·
                <kbd className="bg-slate-100 px-1.5 py-0.5 rounded text-[10px] font-mono text-slate-500 mx-1">
                  Shift+Enter
                </kbd>
                for new line
              </p>
            </div>
          )}

          {/* Type / speak toggle */}
          {!showOutro && questionVisible && !isEvaluating && (
            <div className="text-center">
              {showTextInput ? (
                <button
                  onClick={() => setShowTextInput(false)}
                  className="text-xs text-slate-400 hover:text-indigo-500 transition"
                >
                  ← Prefer to speak?
                </button>
              ) : (
                <button
                  onClick={() => {
                    setShowTextInput(true);
                    setTimeout(() => inputRef.current?.focus(), 50);
                  }}
                  className="text-xs text-slate-400 hover:text-indigo-500 transition"
                >
                  Prefer to type? →
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="h-10 shrink-0" />
    </div>
  );
}
