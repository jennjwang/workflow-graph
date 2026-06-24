import { useState } from "react";
import { WinratePair } from "../../lib/validation/winrateApi";

// Forced A-vs-B judgment over matched pairs, one at a time. The participant picks
// the statement that more accurately and clearly describes their work; we never
// reveal which side is "ours." Produces an ordered list of {pairId, choice}.

export function PairwiseJudgment({
  items,
  onDone,
  submitting = false,
}: {
  items: WinratePair[];
  onDone: (choices: { pairId: string; choice: "A" | "B" }[]) => void;
  submitting?: boolean;
}) {
  const [idx, setIdx] = useState(0);
  const [choices, setChoices] = useState<
    { pairId: string; choice: "A" | "B" }[]
  >([]);
  const [pick, setPick] = useState<"A" | "B" | null>(null);

  const total = items.length;
  const item = items[idx];
  const isLast = idx + 1 >= total;

  const advance = () => {
    if (!pick) return;
    const next = [...choices, { pairId: item.pairId, choice: pick }];
    if (isLast) {
      onDone(next);
      return;
    }
    setChoices(next);
    setIdx(idx + 1);
    setPick(null);
  };

  const optionCard = (side: "A" | "B", texts: string[]) => {
    const active = pick === side;
    return (
      <button
        type="button"
        onClick={() => setPick(side)}
        className={`flex-1 text-left p-5 rounded-2xl border transition active:scale-[0.99] ${
          active
            ? "border-indigo-400 bg-indigo-50 ring-2 ring-indigo-200"
            : "border-slate-200 bg-white hover:border-indigo-200 hover:bg-indigo-50/40"
        }`}
      >
        <span
          className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-semibold mb-3 ${
            active ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-500"
          }`}
        >
          {side}
        </span>
        {texts.length === 1 ? (
          <p className="text-sm text-slate-800 leading-relaxed">{texts[0]}</p>
        ) : (
          <ul className="space-y-2">
            {texts.map((t, i) => (
              <li
                key={i}
                className="text-sm text-slate-800 leading-relaxed flex gap-2"
              >
                <span className="text-slate-300 select-none">•</span>
                <span>{t}</span>
              </li>
            ))}
          </ul>
        )}
      </button>
    );
  };

  return (
    <div className="flex h-full items-center justify-center px-6">
      <div key={idx} className="w-full max-w-3xl animate-fadeSlideIn">
        <div className="flex items-center justify-between">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-indigo-400">
            Comparison {idx + 1} of {total}
          </p>
          <div className="h-1 w-32 rounded-full bg-slate-100 overflow-hidden">
            <div
              className="h-full bg-indigo-400 transition-[width] duration-300"
              style={{ width: `${((idx + 1) / total) * 100}%` }}
            />
          </div>
        </div>

        <h2 className="mt-5 text-xl font-light text-slate-800 leading-snug">
          Which statement more accurately and clearly describes your work?
        </h2>

        <div className="mt-6 flex flex-col sm:flex-row gap-4">
          {optionCard("A", item.A)}
          {optionCard("B", item.B)}
        </div>

        <div className="mt-8 flex justify-end">
          <button
            onClick={advance}
            disabled={!pick || submitting}
            className="inline-flex items-center gap-2 px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-30 disabled:cursor-not-allowed text-white text-sm font-medium rounded-full transition-all active:scale-[0.98] shadow-sm shadow-indigo-200"
          >
            {submitting ? "Submitting…" : isLast ? "Finish" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
