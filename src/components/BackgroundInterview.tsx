import { Fragment, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useWorkflowStore } from "../store";
import {
  evaluateAnswer,
  checkQuestionCoverage,
  fetchInterviewQuestion,
  transcribeAudio,
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
      "SUBSTANCE — the answer must give a concrete sense of the TASKS the work involves, not just generic activity labels. A bare list — e.g. 'I have some zooms and a standup, otherwise I write proposals and do research' — names activities but not the actual tasks within them. When a central activity is named only as a bare label, it is NOT covered — follow up: warmly pick the SINGLE most central still-vague activity and ask what they have to DO for it — the smaller tasks it breaks into — NOT its topic or which specific one (e.g. they say 'I write proposals' → 'What do you need to do to put a proposal together?'; 'I do research' → 'What do you actually have to do when you work on that?'). Probe ONE thread per turn — never interrogate every item at once, never sound skeptical. On later turns, if other central activities they named are STILL bare labels, you may probe ONE more of them; stop once the main parts of a typical week are reasonably concrete. If the central activities already carry concrete task detail, this is covered.",
      "RESPONSIBILITY COVERAGE — earlier in the conversation the participant described their primary responsibilities. If any responsibility or area they named does NOT clearly map to a task they mentioned, it is NOT fully covered: follow up ONCE, warmly, asking whether they regularly do anything on that responsibility (e.g. earlier they said they're responsible for hiring but never mentioned it → 'Earlier you mentioned you're responsible for hiring — is that something you work on in a typical week?'). Probe ONE uncovered responsibility per turn. If they didn't describe their responsibilities, or every responsibility already maps to something they mentioned, this is covered.",
    ],
    maxFollowups: 3,
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
      "DECOMPOSITION — for each main output they named, the TASKS that go into creating or maintaining it should be reasonably clear. When an output is named as a bare noun with no sense of the work behind it, it is NOT covered — follow up ONCE: pick the SINGLE most central output and ask what goes into producing or maintaining it (e.g. they say 'I own the monthly board deck' → 'What goes into putting that together each month?'). Probe ONE output per turn, warmly, never skeptically. On later turns, if other central outputs are still bare nouns, you may decompose ONE more; stop once the work behind their main outputs is reasonably clear.",
      "BREADTH — if they named only ONE output, follow up ONCE: briefly ACKNOWLEDGE it, then ask whether there are other things they produce, maintain, or are accountable for. If they named several distinct outputs, breadth is covered.",
    ],
    maxFollowups: 3,
    minFollowups: 0,
  },
  {
    field: "stakeholders",
    text: "Who do you do your work for or with — the people, teams, or clients you deal with?",
    transition: "Now let's turn to the people side of your work.",
    contextual: true,
    framingNotes:
      "Elicit tasks via the participant's STAKEHOLDERS — the people, teams, roles, clients, or outside parties they do work FOR or WITH. Draw on the social side of work: who they depend on and who depends on them (handoffs both ways), who they coordinate or communicate with, who they report to or support, and anyone OUTSIDE their team or organization (clients, customers, partners, the public). IMPORTANT: phrase this SPECIFICALLY for THIS participant's role and the work they've described — a generic 'who do you work with or for?' is too broad. Use their role to make it concrete (e.g. for a nurse, who they work alongside on a shift and who they care for; for a freelancer, which clients and collaborators on their projects), WITHOUT naming specific people they haven't mentioned. The point is to surface interactions that carry tasks — meetings, handoffs, coordinating, reporting, supporting — then draw out what they actually do with or for each.",
    placeholder: "Who you work for or with — teammates, clients, other teams",
    criteria: [
      "FLOOR — the participant has named at least one person, team, role, or outside party they do work for or with (e.g. 'my manager', 'the sales team', 'patients', 'external vendors'). If they named NONE ('I mostly work alone', 'no one really'), follow up warmly asking who they work for or with, even occasionally.",
      "BREADTH — surface the RANGE of people, not just one: if they named only their immediate team, follow up ONCE asking whether there are others they work for or with — people they depend on, people who depend on them, or anyone outside their team or organization (clients, customers, partners). If they named several distinct parties, breadth is covered.",
      "INTERACTION SUBSTANCE — for the main relationships, it should be clear WHAT the working relationship actually involves task-wise: what they do with or for that person or group (hand off to, coordinate with, report to, support, get input or feedback from). When a stakeholder is named only as a bare label with no sense of the actual exchange, follow up ONCE: warmly pick the SINGLE most central one and ask what they actually do with or for them (e.g. 'You mentioned the design team — what do you usually go to them for, or do for them?'). Probe ONE relationship per turn, never skeptically. If the main relationships already carry concrete substance, this is covered.",
    ],
    maxFollowups: 3,
    minFollowups: 0,
  },
  {
    field: "tools",
    text: "What tools or systems do you use at work, and have any of them changed how you work?",
    transition: "Switching gears for a moment —",
    framingNotes:
      "Elicit tasks via the TOOLS and SYSTEMS the participant uses — the software, platforms, or equipment that are part of their work — and especially how those tools have CHANGED THE WAY THEY WORK: new tasks a tool created (e.g. reviewing or correcting its output, keeping records up to date), steps a tool automated away, or a different process they now follow because of it. Keep it warm and concrete; you MAY offer a couple of examples that fit any job, but do NOT read a checklist. The point is to surface tool-shaped tasks and workflow changes they'd skip when narrating activities, then draw out what they actually do with each tool.",
    placeholder: "The software, systems, or equipment you use",
    criteria: [
      "FLOOR — the participant has either named at least one tool/system/equipment they use, OR indicated they don't really use notable tools. A 'no', 'not really', 'I don't focus on specific tools', or 'just the basics' is a COMPLETE, valid answer — accept it and move on; do NOT re-ask the same thing in another form. Only if they haven't addressed tools AT ALL may you ask ONCE, warmly, what software, systems, or equipment they use; if they then decline, that's covered.",
      "WORKFLOW CHANGE — ONLY relevant if they actually named tools. In that case, surface HOW a tool changed what they do: a new task it created, a step it automated away, or a different way they now work. If they listed tools but said nothing about their effect, you MAY follow up ONCE. If they said they don't use notable tools, or already described an effect, this is covered — do NOT push someone who said they don't use specific tools.",
      "USE SUBSTANCE — ONLY relevant if they named tools, and only as bare labels: follow up ONCE, warmly picking the SINGLE most central one and asking what they use it for. Probe ONE tool per turn, never skeptically. If they declined, or the tools already carry a concrete sense of use, this is covered.",
    ],
    maxFollowups: 2,
    minFollowups: 0,
  },
  {
    field: "invisibleWork",
    text: "Is there any work you do that tends to go unnoticed — that people would only notice if it stopped?",
    transition:
      "One last thing — I want you to think about the invisible tasks in your work.",
    staticText: true,
    framingNotes:
      "Elicit the INVISIBLE or under-recognized work — the necessary background tasks that keep things running but go unnoticed until they STOP: maintenance, checking and monitoring, coordinating, cleanup, chasing loose ends, preventing problems before they happen, the 'glue' work, the quiet emotional labor. This is a reflective, optional-feeling question: keep it warm and low-pressure, and a simple 'no' is a perfectly fine answer. You MAY offer one gentle example, but do NOT supply a list and do NOT pressure them to produce something.",
    placeholder: "Something behind-the-scenes that keeps things running",
    criteria: [
      "FLOOR — a 'no', 'nothing comes to mind', or 'not really' is a COMPLETE, valid answer here: accept it and move on, do NOT follow up to push for something. Only if they gave a partial or abstract gesture toward something ('I guess I keep things organized') without a concrete task may you follow up ONCE, gently, asking what that looks like. Never pressure them to name invisible work they don't feel they have.",
      "SUBSTANCE — if they DID name some invisible work but only as a vague label ('I keep things organized', 'I smooth things over'), follow up ONCE: warmly ask what they concretely do — the actual task behind it. Probe ONE thread per turn, never skeptically. If they declined ('no') or what they named already carries concrete substance, this is covered.",
    ],
    maxFollowups: 2,
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
  "Last one: if someone shadowed you for two weeks, what tasks would they see that we haven't named yet?";

// AUTO skip (#3): questions eligible to be skipped automatically when earlier
// answers already cover their criteria. The opening role question and the
// responsibilities question always run.
const AUTO_SKIP_FIELDS = new Set<string>([
  "typicalWeek",
  "outputs",
  "stakeholders",
  "tools",
  "invisibleWork",
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
  // it the rest of the way toward the next step.
  const progress = showOutro
    ? 1
    : Math.min(
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
    setShowOutro(true);
    setQuestionVisible(true);
  };

  const advance = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || isEvaluating) return;

    setInput("");
    setShowTextInput(false);

    // Record this turn (initial Q or follow-up Q paired with the participant's answer)
    addBackgroundTurn({
      field: q.field,
      question: displayQuestion,
      answer: trimmed,
      isFollowUp: isFollowUpActive,
      timestamp: Date.now(),
    });
    // Append to the running conversation transcript (what was actually asked + said)
    convoRef.current.push({ q: displayQuestion, a: trimmed });

    // Build up the full answer context for coverage evaluation
    const combined = isFollowUpActive
      ? `${accumulatedAnswer}\n${trimmed}`
      : trimmed;

    // They just answered the final catch-all — finish up (any answer, or skip).
    if (isClosingActive) {
      await finishInterview();
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
