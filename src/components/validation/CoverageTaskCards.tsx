import { useState } from "react";

// Per-task pass for the coverage study: go through each inventory statement one
// at a time — "do you do this?" and, if so, "how many hours per week?" Produces a
// map of row key (s<i>) → hours (0 for tasks they don't do), which seeds the
// adjustable summary that follows.

export function CoverageTaskCards({
  statements,
  onDone,
}: {
  statements: string[];
  onDone: (hoursByKey: Record<string, number>) => void;
}) {
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [choice, setChoice] = useState<"yes" | "no" | null>(null);
  const [hoursInput, setHoursInput] = useState("");

  const total = statements.length;
  const statement = statements[idx];
  const key = `s${idx}`;

  const hoursValue = parseFloat(hoursInput);
  const hoursValid = Number.isFinite(hoursValue) && hoursValue > 0;
  const canContinue = choice === "no" || (choice === "yes" && hoursValid);

  const advance = () => {
    if (!canContinue) return;
    const next = { ...answers, [key]: choice === "yes" ? hoursValue : 0 };
    if (idx + 1 >= total) {
      onDone(next);
      return;
    }
    setAnswers(next);
    setIdx(idx + 1);
    setChoice(null);
    setHoursInput("");
  };

  const choiceBtn = (active: boolean) =>
    `flex-1 px-5 py-4 rounded-xl border text-sm font-medium transition active:scale-[0.99] ${
      active
        ? "border-indigo-400 bg-indigo-50 text-indigo-700 ring-2 ring-indigo-200"
        : "border-slate-200 bg-white text-slate-600 hover:border-indigo-200 hover:bg-indigo-50/40"
    }`;

  return (
    <div className="flex flex-col h-full">
      {/* Progress header — pinned to the top of the screen */}
      <div className="shrink-0 px-6 pt-8 pb-2">
        <div className="mx-auto flex w-full max-w-2xl items-center gap-8">
          <p className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.18em] text-indigo-400">
            Task {idx + 1} of {total}
          </p>
          <div className="h-1.5 flex-1 rounded-full bg-slate-100 overflow-hidden">
            <div
              className="h-full bg-indigo-400 transition-[width] duration-300"
              style={{ width: `${((idx + 1) / total) * 100}%` }}
            />
          </div>
        </div>
      </div>

      {/* Question + answer — centered in the remaining space */}
      <div className="flex flex-1 items-center justify-center px-6 pb-10">
        <div key={idx} className="w-full max-w-2xl animate-fadeSlideIn">
          <p className="text-[1.6rem] font-light text-slate-800 leading-snug">
            {statement}
          </p>

          <p className="mt-9 text-sm font-medium text-slate-600">
          Do you spend time on this in a typical week?
        </p>
        <div className="mt-4 flex gap-4">
          <button
            type="button"
            className={choiceBtn(choice === "yes")}
            onClick={() => setChoice("yes")}
          >
            Yes, I do this
          </button>
          <button
            type="button"
            className={choiceBtn(choice === "no")}
            onClick={() => {
              setChoice("no");
              setHoursInput("");
            }}
          >
            No, I don't
          </button>
        </div>

        {choice === "yes" && (
          <div className="mt-7 animate-fadeSlideIn">
            <label className="block text-sm font-medium text-slate-600">
              About how many hours per week?
            </label>
            <div className="mt-3 flex items-center gap-3">
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step={0.5}
                autoFocus
                value={hoursInput}
                onChange={(e) => setHoursInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canContinue) advance();
                }}
                placeholder="0"
                className="w-28 rounded-xl border border-slate-200 bg-white px-4 py-3 text-lg text-center text-slate-800 tabular-nums transition focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-200"
              />
              <span className="text-sm text-slate-500">hours / week</span>
            </div>
          </div>
        )}

        <div className="mt-10 flex justify-end">
          <button
            onClick={advance}
            disabled={!canContinue}
            className="inline-flex items-center gap-2 px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-30 disabled:cursor-not-allowed text-white text-sm font-medium rounded-full transition-all active:scale-[0.98] shadow-sm shadow-indigo-200"
          >
            {idx + 1 >= total ? "Review" : "Continue"}
          </button>
          </div>
        </div>
      </div>
    </div>
  );
}
