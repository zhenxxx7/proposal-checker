"use client";

import { useEffect } from "react";
import { Button } from "./ui";

export interface AiProgressState {
  done: number;
  total: number;
  label: string;
}

type StepState = "pending" | "active" | "done";

/**
 * A blocking-but-dismissable overlay that surfaces the auto-run AI pass. The
 * pass already fires on its own the instant a deck is parsed; this just makes
 * the wait legible instead of a 2px bar the eye slides past. "Run in
 * background" hands the deck back while the requests keep streaming in.
 */
export function AiProgress({
  open,
  progress,
  images,
  provider,
  onCancel,
  onMinimize,
}: {
  open: boolean;
  progress: AiProgressState;
  images: number;
  provider: string;
  onCancel: () => void;
  onMinimize: () => void;
}) {
  // Esc backgrounds the run (keeps it going) rather than cancelling — losing a
  // rate-limited pass to a stray keypress would be a nasty surprise.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onMinimize();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onMinimize]);

  if (!open) return null;

  const { done, total, label } = progress;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const known = total > 0;

  // total = 1 (text pass) + one request per deduped image.
  const textStep: StepState = done >= 1 ? "done" : "active";
  const imageStep: StepState = done < 1 ? "pending" : done >= total ? "done" : "active";

  return (
    <div
      className="fade fixed inset-0 z-50 grid place-items-center bg-zinc-950/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Analyzing slides with AI"
      onClick={onMinimize}
    >
      <div
        className="rise w-full max-w-md overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col items-center gap-4 px-7 pt-8 pb-6 text-center">
          <Orbit />
          <div>
            <h2 className="text-[15px] font-semibold">Analyzing your slides…</h2>
            <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400">
              {label || "Warming up the model…"}
            </p>
          </div>

          <div className="w-full">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
              {known ? (
                <div
                  className="h-full rounded-full bg-indigo-600 transition-all duration-500 dark:bg-indigo-400"
                  style={{ width: `${Math.max(pct, 4)}%` }}
                />
              ) : (
                <div className="sweep h-full w-1/3 rounded-full bg-indigo-600 dark:bg-indigo-400" />
              )}
            </div>
            <p className="mt-1.5 text-[11px] tabular-nums text-zinc-400">
              {known ? `${done} of ${total} · ${pct}%` : "Starting…"}
            </p>
          </div>
        </div>

        <div className="space-y-1 border-t border-zinc-100 px-5 py-4 dark:border-zinc-800">
          <Step state={textStep} label="Proofreading slide text" />
          <Step
            state={imageStep}
            label={images ? `Reading ${images} image${images === 1 ? "" : "s"}` : "No images to read"}
          />
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-zinc-100 px-5 py-3 dark:border-zinc-800">
          <span className="truncate text-[11px] text-zinc-400" title={provider}>
            {provider}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" onClick={onMinimize}>
              Run in background
            </Button>
            <Button onClick={onCancel} title="Stop and keep what was found so far">
              Cancel
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** A row in the step checklist: spinner while active, check when done. */
function Step({ state, label }: { state: StepState; label: string }) {
  return (
    <div
      className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition ${
        state === "active"
          ? "bg-indigo-50 text-zinc-900 dark:bg-indigo-500/10 dark:text-zinc-100"
          : state === "done"
            ? "text-zinc-500 dark:text-zinc-400"
            : "text-zinc-400 dark:text-zinc-500"
      }`}
    >
      <span className="grid h-4 w-4 shrink-0 place-items-center">
        {state === "done" ? (
          <svg viewBox="0 0 16 16" className="h-4 w-4 text-emerald-500" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="m3 8.5 3.5 3.5L13 4.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : state === "active" ? (
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-indigo-300 border-t-indigo-600 dark:border-indigo-500/40 dark:border-t-indigo-400" />
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-zinc-300 dark:bg-zinc-600" />
        )}
      </span>
      <span>{label}</span>
    </div>
  );
}

/** A soft pulsing badge — reads as "thinking" without a literal spinner. */
function Orbit() {
  return (
    <span className="relative grid h-14 w-14 place-items-center">
      <span className="absolute inset-0 animate-ping rounded-full bg-indigo-500/20" />
      <span className="grid h-14 w-14 place-items-center rounded-full bg-indigo-600 text-white shadow-lg dark:bg-indigo-500">
        <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor" aria-hidden>
          <path d="M12 2.5l1.6 3.9 4.2.3-3.2 2.7 1 4.1L12 11.3 8.4 13.5l1-4.1L6.2 6.7l4.2-.3L12 2.5z" />
          <circle cx="18.5" cy="16.5" r="1.6" />
          <circle cx="6" cy="15" r="1.1" />
        </svg>
      </span>
    </span>
  );
}
