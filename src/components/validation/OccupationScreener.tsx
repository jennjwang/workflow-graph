import { useState } from "react";
import { verifyOccupation } from "../../lib/validation/screenerApi";

// Shared occupation screener UI. Collects job title + day-to-day duties, runs the
// server-side classification, and calls back on the outcome. The target
// occupation is never shown (placeholders use an unrelated occupation so they
// don't cue the answer). Renders inner content only — wrap in a study's Frame.

export function OccupationScreener({
  externalId,
  onPass,
  onFail,
  onError,
}: {
  externalId: string;
  onPass: () => void; // verified match — caller proceeds (assign, etc.)
  onFail: () => void; // non-match — caller shows the screen-out
  onError?: (msg: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [duties, setDuties] = useState("");
  const [busy, setBusy] = useState(false);
  const [retryNote, setRetryNote] = useState("");

  const canVerify = title.trim().length > 0 && duties.trim().length >= 3;

  const submit = async () => {
    if (!canVerify || busy) return;
    setRetryNote("");
    setBusy(true);
    try {
      const v = await verifyOccupation(externalId, title.trim(), duties.trim());
      if (v.match) onPass();
      else onFail();
      return; // leave busy set — the caller unmounts this screen
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      if (msg === "RETRY") {
        setRetryNote("We couldn't check that just now. Please try again.");
      } else {
        onError?.(msg);
      }
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="w-full max-w-xl animate-fadeSlideIn">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-indigo-400">
          Before we begin
        </p>
        <h1 className="mt-4 text-2xl font-light text-slate-800 leading-snug">
          What's your current job?
        </h1>

        <label className="mt-6 block text-sm font-medium text-slate-700">
          Your job title
        </label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={busy}
          placeholder="e.g. Registered Nurse"
          className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 transition focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-60"
        />

        <label className="mt-5 block text-sm font-medium text-slate-700">
          What do you actually do day-to-day?
        </label>
        <p className="mt-1 text-xs text-slate-400 leading-relaxed">
          Describe your main responsibilities and the work you spend the most
          time on — this matters more than the title.
        </p>
        <textarea
          value={duties}
          onChange={(e) => setDuties(e.target.value)}
          rows={4}
          disabled={busy}
          placeholder="e.g. I care for patients on a hospital ward, give medications, monitor vitals, and coordinate with doctors on treatment plans."
          className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 leading-relaxed transition focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-60"
        />
        {retryNote && <p className="mt-2 text-sm text-amber-600">{retryNote}</p>}
        <div className="mt-6 flex justify-end">
          <button
            onClick={submit}
            disabled={!canVerify || busy}
            className="inline-flex items-center gap-2 px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-30 disabled:cursor-not-allowed text-white text-sm font-medium rounded-full transition-all active:scale-[0.98] shadow-sm shadow-indigo-200"
          >
            {busy ? "Checking…" : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}
