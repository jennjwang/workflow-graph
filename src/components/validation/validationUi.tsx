// Shared chrome for the standalone validation studies (coverage, win rate).

export const Frame = ({ children }: { children: React.ReactNode }) => (
  <div className="relative flex app-screen w-screen overflow-hidden bg-white">
    <div className="absolute top-0 left-0 right-0 h-48 bg-gradient-to-b from-indigo-50/40 to-transparent pointer-events-none" />
    <div className="relative w-full max-w-[1040px] mx-auto h-full">{children}</div>
  </div>
);

export const Centered = ({ children }: { children: React.ReactNode }) => (
  <div className="flex h-full items-center justify-center px-6 text-center">
    <div className="max-w-lg animate-fadeSlideIn">{children}</div>
  </div>
);

export function resolveExternalId(): string {
  const q = new URLSearchParams(window.location.search);
  const raw =
    q.get("externalId") || q.get("PROLIFIC_PID") || q.get("pid") || "";
  return raw.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}
