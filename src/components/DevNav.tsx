import { useState } from 'react';
import { useWorkflowStore } from '../store';
import type { Phase } from '../types';

// Dev-only floating page picker. Visible whenever the URL carries `review=1`,
// letting you jump between every page App renders without hand-editing the URL.
// Each entry links to `?dev=<phase>&review=1` (plus any sub-page params), so
// navigation goes through the URL and the app re-inits cleanly on that page.
// App skips session hydration AND the "Leave site?" prompt while review mode is
// on, so these are plain reloads with no interruption.

type Page = {
  phase: Phase;
  label: string;
  // Extra query params for sub-pages of the same phase (e.g. the per-task card
  // view of task-selection). Cleared on every other entry.
  params?: Record<string, string>;
};

// Only the phases App renders a distinct screen for, in study order.
const PAGES: Page[] = [
  { phase: 'setup', label: 'Welcome' },
  { phase: 'background', label: 'Background interview' },
  { phase: 'task-selection', label: 'Task selection (review)' },
  { phase: 'task-selection', label: 'Task selection (task card)', params: { card: '1' } },
  { phase: 'final-questions', label: 'Final questions' },
  { phase: 'study-complete', label: 'Study complete' },
  { phase: 'screen-out', label: 'Screen out' },
];

// Query keys that are sub-page selectors — wiped before applying an entry's own
// params so switching pages never leaves a stale selector behind.
const SUBPAGE_KEYS = ['card', 'hours'];

function hrefFor(page: Page): string {
  const params = new URLSearchParams(window.location.search);
  params.set('dev', page.phase);
  params.set('review', '1');
  SUBPAGE_KEYS.forEach(k => params.delete(k));
  if (page.params) {
    for (const [k, v] of Object.entries(page.params)) params.set(k, v);
  }
  return `${window.location.pathname}?${params.toString()}`;
}

// Is this entry the one currently showing? Match phase plus every sub-page key,
// so e.g. task-selection's review / card / hours entries don't all light up.
function isActive(page: Page, phase: Phase): boolean {
  if (page.phase !== phase) return false;
  const search = new URLSearchParams(window.location.search);
  return SUBPAGE_KEYS.every(
    (k) => (page.params?.[k] === '1') === (search.get(k) === '1'),
  );
}

export function DevNav() {
  const reviewMode =
    new URLSearchParams(window.location.search).get('review') === '1';
  const phase = useWorkflowStore(s => s.phase);
  const [open, setOpen] = useState(true);

  if (!reviewMode) return null;

  return (
    <div className="fixed top-3 right-3 z-[9999] font-sans text-[13px] select-none">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 rounded-md bg-slate-900/90 px-2.5 py-1.5 text-white shadow-lg backdrop-blur hover:bg-slate-900"
      >
        <span className="text-[11px] uppercase tracking-wide text-slate-300">Pages</span>
        <span className="text-slate-400">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <nav className="mt-1.5 w-56 overflow-hidden rounded-md bg-slate-900/95 py-1 shadow-xl backdrop-blur">
          {PAGES.map(p => {
            const active = isActive(p, phase);
            return (
              <a
                key={p.label}
                href={hrefFor(p)}
                className={
                  'block px-3 py-1.5 transition-colors ' +
                  (active
                    ? 'bg-indigo-500 text-white'
                    : 'text-slate-200 hover:bg-slate-700/70')
                }
              >
                {p.label}
              </a>
            );
          })}
        </nav>
      )}
    </div>
  );
}
