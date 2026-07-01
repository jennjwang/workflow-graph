import { useState } from "react";

// Reusable weekly-hours allocation, extracted from the interview's "Your week at
// a glance" screen (TaskSelection) so the held-out coverage study can reuse the
// exact slider/stepper interaction. The key difference from the interview wrapper
// is the residual: a single fixed "Other" bucket captures time the incumbent
// can't place on any listed statement. That bucket — uncovered time — is the
// metric, so it's surfaced explicitly rather than rescaled away.

export interface AllocationRow {
  key: string;
  name: string;
}

export interface AllocationResult {
  totalHours: number;
  allocations: { name: string; hours: number; source: "inventory" | "other" }[];
  coveredHours: number;
  uncoveredHours: number;
}

// Reserved row key for the fixed "Other" bucket.
const OTHER_KEY = "__other__";

function formatHours(n: number): string {
  return Number.isInteger(n) ? `${n}` : `${n.toFixed(1)}`;
}

const TASK_PALETTE = [
  "#6366f1", "#0ea5e9", "#14b8a6", "#f59e0b", "#f43f5e", "#8b5cf6",
  "#10b981", "#fb7185", "#3b82f6", "#a855f7", "#f97316", "#06b6d4",
];
function segmentColor(i: number): string {
  return TASK_PALETTE[i % TASK_PALETTE.length];
}

const SLIDER_MAX = 40;
const OTHER_COLOR = "#94a3b8"; // slate-400 — visually distinct from the task palette

function HoursSliderRow({
  name,
  hours,
  color,
  badge,
  onChange,
}: {
  name: string;
  hours: number;
  color: string;
  badge?: string;
  onChange: (hours: number) => void;
}) {
  const sliderValue = Math.min(Math.max(hours, 0), SLIDER_MAX);
  const commit = (v: number) => onChange(Math.max(0, Math.round(v * 2) / 2));
  const stepBtn =
    "w-8 h-8 shrink-0 rounded-lg border border-slate-200 text-slate-400 hover:border-indigo-300 hover:text-indigo-500 hover:bg-indigo-50 active:scale-95 transition flex items-center justify-center text-base leading-none";

  return (
    <div className="py-2">
      <p className="flex items-center gap-2 text-sm font-medium text-slate-700">
        <span
          className="w-2 h-2 rounded-full shrink-0 ring-2 ring-white shadow-sm"
          style={{ background: color }}
        />
        <span>{name}</span>
        {badge && (
          <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            {badge}
          </span>
        )}
      </p>
      <div className="mt-1.5 flex items-center gap-4">
        <input
          type="range"
          min={0}
          max={SLIDER_MAX}
          step={0.5}
          value={sliderValue}
          onChange={(e) => commit(parseFloat(e.target.value))}
          style={
            {
              color,
              "--fill": color,
              "--pct": `${(sliderValue / SLIDER_MAX) * 100}%`,
            } as React.CSSProperties
          }
          className="hours-slider flex-1 min-w-0 cursor-pointer"
        />
        <div className="shrink-0 flex items-center gap-2">
          <button
            type="button"
            aria-label={`Decrease hours for ${name}`}
            onClick={() => commit(hours - 0.5)}
            className={stepBtn}
          >
            −
          </button>
          <div className="w-11 text-center">
            <span className="text-base font-medium text-slate-800 tabular-nums">
              {formatHours(hours)}
            </span>
            <span className="ml-0.5 text-xs text-slate-400">h</span>
          </div>
          <button
            type="button"
            aria-label={`Increase hours for ${name}`}
            onClick={() => commit(hours + 0.5)}
            className={stepBtn}
          >
            +
          </button>
        </div>
      </div>
    </div>
  );
}

export function TimeAllocation({
  rows,
  totalQuestion = "In an average week, how many hours do you work?",
  totalHelp = "Your best estimate of total hours across all your work in a typical week.",
  breakdownTitle = "Your week at a glance",
  breakdownHelp = "Set the hours you spend on each task. Put any time these tasks don't capture into “Other.”",
  otherLabel = "Other — work these tasks don't capture",
  submitLabel = "Submit",
  submitting = false,
  initialStep = "total",
  initialTotalHours = null,
  initialHours,
  initialOtherHours = 0,
  onSubmit,
}: {
  rows: AllocationRow[];
  totalQuestion?: string;
  totalHelp?: string;
  breakdownTitle?: string;
  breakdownHelp?: string;
  otherLabel?: string;
  submitLabel?: string;
  submitting?: boolean;
  // Seeding: start directly at the breakdown with a known total and per-row
  // hours (e.g. pre-filled from a per-task pass). Other defaults to the residual.
  initialStep?: "total" | "breakdown";
  initialTotalHours?: number | null;
  initialHours?: Record<string, number>;
  initialOtherHours?: number;
  onSubmit: (r: AllocationResult) => void;
}) {
  const [step, setStep] = useState<"total" | "breakdown">(initialStep);
  const [totalHours, setTotalHours] = useState<number | null>(initialTotalHours);
  // Every row (inventory statements + the fixed "Other" bucket) defaults to 0 —
  // "I don't do this" is a valid, meaningful answer — then overlay any seeds.
  const [hours, setHours] = useState<Record<string, number>>(() => {
    const base: Record<string, number> = {
      ...Object.fromEntries(rows.map((r) => [r.key, 0])),
      [OTHER_KEY]: initialOtherHours,
    };
    if (initialHours) {
      for (const [k, v] of Object.entries(initialHours)) base[k] = v;
    }
    return base;
  });

  const setRowHours = (key: string, h: number) =>
    setHours((p) => ({ ...p, [key]: h }));

  const items = [
    ...rows.map((r, i) => ({
      key: r.key,
      name: r.name,
      hours: hours[r.key] ?? 0,
      color: segmentColor(i),
      source: "inventory" as const,
      badge: undefined as string | undefined,
    })),
    {
      key: OTHER_KEY,
      name: otherLabel,
      hours: hours[OTHER_KEY] ?? 0,
      color: OTHER_COLOR,
      source: "other" as const,
      badge: undefined as string | undefined,
    },
  ];

  const total = totalHours ?? 0;
  const allocated = items.reduce((s, it) => s + it.hours, 0);
  const covered = items
    .filter((it) => it.source === "inventory")
    .reduce((s, it) => s + it.hours, 0);
  const unaccounted = Math.max(0, total - allocated);
  const over = allocated - total; // >0 means they placed more than they work
  const avgValid = totalHours != null && totalHours > 0;
  // Everything must be accounted for: on a statement, or in "Other." That
  // discipline is what makes the covered share trustworthy rather than an
  // artifact of who stopped allocating early.
  const fullyAccounted = avgValid && Math.abs(total - allocated) < 0.5;

  const handleSubmit = () => {
    if (!fullyAccounted || submitting) return;
    onSubmit({
      totalHours: total,
      allocations: items.map((it) => ({
        name: it.name,
        hours: it.hours,
        source: it.source,
      })),
      coveredHours: covered,
      uncoveredHours: Math.max(0, total - covered),
    });
  };

  return (
    <div className="flex flex-col h-full bg-transparent relative overflow-hidden">
      <div className="relative z-10 px-5 sm:px-8 pt-7 sm:pt-8 pb-5 shrink-0">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-indigo-400 mb-4">
          Time breakdown
        </p>
      </div>

      {step === "total" ? (
        <div className="relative z-10 flex-1 flex flex-col min-h-0 overflow-y-auto py-12 px-5 sm:px-8">
          <div className="w-full my-auto animate-fadeSlideIn">
            <div className="text-center max-w-xl mx-auto">
              <h2 className="text-[1.5rem] font-light text-slate-800 leading-snug tracking-tight">
                {totalQuestion}
              </h2>
              <p className="text-sm text-slate-500 mt-2 leading-relaxed">
                {totalHelp}
              </p>
              <div className="mt-6 flex items-center justify-center gap-3">
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step={0.5}
                  value={totalHours ?? ""}
                  onChange={(e) => {
                    const v = e.target.value.trim();
                    if (v === "") return setTotalHours(null);
                    const parsed = parseFloat(v);
                    setTotalHours(
                      Number.isFinite(parsed) && parsed >= 0 ? parsed : null,
                    );
                  }}
                  className="w-28 rounded-xl border border-slate-200 bg-white px-4 py-3 text-lg text-center text-slate-800 tabular-nums transition focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-200"
                />
                <span className="text-sm text-slate-500">hours / week</span>
              </div>
              <div className="mt-8 flex justify-center">
                <button
                  onClick={() => setStep("breakdown")}
                  disabled={!avgValid}
                  className="shrink-0 inline-flex items-center gap-2 px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-30 disabled:cursor-not-allowed text-white text-sm font-medium rounded-full transition-all active:scale-[0.98] shadow-sm shadow-indigo-200"
                >
                  Continue
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="relative z-10 flex-1 flex flex-col min-h-0 overflow-y-auto w-full max-w-4xl mx-auto px-5 sm:px-8 animate-fadeSlideIn">
          <div className="w-full">
            <div className="sticky top-0 z-20 bg-white/95 backdrop-blur-sm pt-4 pb-4">
              <h2 className="text-[1.5rem] font-light text-slate-800 leading-snug tracking-tight">
                {breakdownTitle}
              </h2>
              <p className="text-sm text-slate-500 mt-2 leading-relaxed">
                {breakdownHelp}
              </p>

              <div className="mt-6 px-6 py-5 rounded-2xl bg-indigo-50/70">
                <div>
                  <span className="text-3xl font-semibold text-indigo-600 tabular-nums align-middle">
                    {formatHours(covered)}
                  </span>
                  <span className="ml-2 text-sm text-slate-500 align-middle">
                    of {formatHours(total)} hours on these tasks
                    {total > 0 && (
                      <span className="ml-2 text-slate-400">
                        · {((covered / total) * 100).toFixed(0)}% covered
                      </span>
                    )}
                  </span>
                </div>

                <div className="mt-4 flex w-full h-12 rounded-xl overflow-hidden bg-indigo-100/60 ring-1 ring-inset ring-indigo-200/50">
                  {total > 0 ? (
                    <>
                      {items.map((it) => {
                        const pct = (it.hours / total) * 100;
                        if (pct <= 0) return null;
                        return (
                          <div
                            key={it.key}
                            className="flex items-center justify-center text-white text-sm font-semibold border-r-[3px] border-white last:border-r-0 overflow-hidden whitespace-nowrap transition-[width] duration-300 ease-out"
                            style={{
                              width: `${pct}%`,
                              background: it.color,
                              textShadow: "0 1px 2px rgba(15,23,42,0.18)",
                            }}
                            title={`${it.name}: ${formatHours(it.hours)}h`}
                          >
                            {pct >= 6 ? formatHours(it.hours) : ""}
                          </div>
                        );
                      })}
                      {unaccounted > 0 && (
                        <div
                          className="flex items-center justify-center text-slate-500 text-xs font-medium overflow-hidden whitespace-nowrap bg-slate-200"
                          style={{ width: `${(unaccounted / total) * 100}%` }}
                          title={`Unaccounted: ${formatHours(unaccounted)}h`}
                        >
                          {(unaccounted / total) * 100 >= 8
                            ? `${formatHours(unaccounted)} left`
                            : ""}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="flex items-center justify-center w-full text-xs text-slate-400">
                      Set hours below to see your week
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="pb-8">
              <div className="divide-y divide-slate-100">
                {items.map((it) => (
                  <HoursSliderRow
                    key={it.key}
                    name={it.name}
                    hours={it.hours}
                    color={it.color}
                    badge={it.badge}
                    onChange={(h) => setRowHours(it.key, h)}
                  />
                ))}
              </div>

              <div className="pt-4 pb-4 mt-2 border-t border-slate-100">
                {avgValid && unaccounted >= 0.5 && (
                  <div className="mt-2 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                    <svg className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                      <line x1="12" y1="9" x2="12" y2="13" />
                      <line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                    <p className="text-sm text-amber-800 leading-relaxed">
                      <span className="font-semibold">{formatHours(unaccounted)}</span>{" "}
                      hours aren't accounted for yet. Put them on a task above, or
                      into <span className="font-semibold">Other</span> if these
                      tasks don't capture that work.
                    </p>
                  </div>
                )}

                {avgValid && over >= 0.5 && (
                  <div className="mt-2 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3">
                    <p className="text-sm text-rose-800 leading-relaxed">
                      You've allocated <span className="font-semibold">{formatHours(allocated)}</span>{" "}
                      hours but said you work <span className="font-semibold">{formatHours(total)}</span>.
                      Lower some rows so they add up to your weekly total.
                    </p>
                  </div>
                )}

                <div className="mt-4 flex items-center justify-end gap-3">
                  {!fullyAccounted && (
                    <p className="text-xs text-slate-400">
                      Account for all {formatHours(total)} hours to continue.
                    </p>
                  )}
                  <button
                    onClick={handleSubmit}
                    disabled={!fullyAccounted || submitting}
                    className="shrink-0 inline-flex items-center gap-2 px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-30 disabled:cursor-not-allowed text-white text-sm font-medium rounded-full transition-all active:scale-[0.98] shadow-sm shadow-indigo-200"
                  >
                    {submitting ? "Submitting…" : submitLabel}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
