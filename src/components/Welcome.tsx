import { useWorkflowStore } from "../store";

export function Welcome() {
  const setPhase = useWorkflowStore((s) => s.setPhase);

  return (
    <div className="min-h-screen bg-white relative overflow-hidden flex flex-col">
      <div className="absolute top-0 left-0 right-0 h-72 bg-gradient-to-b from-indigo-50/40 to-transparent pointer-events-none" />

      {/* Welcome card */}
      <div className="relative z-10 flex-1 flex items-center justify-center px-5 sm:px-6 py-10 sm:py-12">
        <div className="max-w-2xl w-full">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-indigo-400 mb-4">
            Welcome
          </p>
          <h1 className="text-[1.6rem] sm:text-[2rem] font-light text-slate-800 leading-tight tracking-[-0.015em] mb-6">
            About this study
          </h1>

          <div className="space-y-4 text-[15px] text-slate-600 leading-relaxed">
            <p>
              Thank you for participating. We're developing better ways to
              understand how people's tasks at work are changing as they use AI
              tools.
            </p>
            <p>
              You'll have a short conversation with an AI interviewer about your
              role and a typical week. From your answers, we'll put together a
              task list for you to review — mark what applies, reword anything
              that doesn't quite fit, and add tasks we might have missed.
            </p>
            <p>
              Before you begin, please review the{" "}
              <a
                href="https://docs.google.com/document/d/15IlS2zdtZ9z28jNMu3i8KIb3YoaeIKk2/edit?usp=sharing&ouid=115842279112732201256&rtpof=true&sd=true"
                target="_blank"
                rel="noopener noreferrer"
                className="text-indigo-600 hover:text-indigo-700 underline font-medium"
              >
                consent form
              </a>{" "}
              (opens in a new tab).
            </p>
            {/* <p>
              <strong className="font-medium text-slate-700">
                How it works:
              </strong>{" "}
              Please respond in your own words and review each task carefully. A
              few attention-check items are mixed in, so only select tasks that
              are actually part of your work.
            </p> */}
          </div>

          <div className="mt-8 border border-slate-200 rounded-2xl p-5 bg-slate-50/50">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500 mb-3">
              Privacy Notice
            </h3>
            <p className="text-sm text-slate-600 leading-relaxed">
              You are{" "}
              <strong className="font-medium text-slate-700">
                not required
              </strong>{" "}
              to share any personally identifiable information. We do not
              collect or store PII.
            </p>
            <p className="text-sm text-slate-600 leading-relaxed mt-3">
              <strong className="font-medium text-slate-700">
                You do not need to provide:
              </strong>
            </p>
            <ul className="mt-2 space-y-1 text-sm text-slate-600">
              {[
                "Full name, age, or date of birth",
                "Physical address or precise location",
                "Contact information (phone, email)",
                "Government IDs or financial information",
              ].map((item) => (
                <li key={item} className="flex items-start gap-2">
                  <span className="mt-2 w-1 h-1 rounded-full bg-slate-400 shrink-0" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>

          <p className="mt-12 text-xs text-slate-500 leading-relaxed">
            By clicking “Begin interview,” you confirm that you have read and
            agree to the{" "}
            <a
              href="https://docs.google.com/document/d/15IlS2zdtZ9z28jNMu3i8KIb3YoaeIKk2/edit?usp=sharing&ouid=115842279112732201256&rtpof=true&sd=true"
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-600 hover:text-indigo-700 underline font-medium"
            >
              consent form
            </a>
            .
          </p>

          <button
            onClick={() => setPhase("background")}
            className="mt-4 inline-flex items-center gap-2 px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-full transition-all active:scale-[0.98] shadow-sm shadow-indigo-200"
          >
            Begin interview
            <svg
              className="w-4 h-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="13 6 19 12 13 18" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
