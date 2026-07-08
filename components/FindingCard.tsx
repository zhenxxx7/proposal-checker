"use client";

import type { Finding, Severity } from "@/lib/types";

const TONE: Record<Severity, string> = {
  error: "border-l-rose-500 bg-rose-50/60 dark:bg-rose-950/20",
  warn: "border-l-amber-500 bg-amber-50/60 dark:bg-amber-950/20",
  info: "border-l-sky-500 bg-sky-50/60 dark:bg-sky-950/20",
};

const SOURCE_LABEL = { rule: "rule", "ai-text": "AI · text", "ai-image": "AI · image" } as const;

export function FindingCard({
  f,
  active,
  onClick,
}: {
  f: Finding;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full border-l-4 px-3 py-2.5 text-left transition ${TONE[f.severity]} ${
        active ? "ring-2 ring-inset ring-neutral-900 dark:ring-neutral-100" : "hover:brightness-95"
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold">{f.title}</span>
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-neutral-500">
          s{f.slide} · {SOURCE_LABEL[f.source]}
        </span>
      </div>
      <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">{f.detail}</p>
      {f.quote && (
        <p className="mt-1.5 truncate font-mono text-[11px] text-neutral-700 dark:text-neutral-300">
          <span className="text-neutral-400">found</span> {f.quote}
        </p>
      )}
      {f.suggestion && (
        <p className="truncate font-mono text-[11px] text-emerald-700 dark:text-emerald-400">
          <span className="text-neutral-400">fix</span> {f.suggestion}
        </p>
      )}
      {!!f.relatedSlides?.length && (
        <p className="mt-1 text-[11px] text-neutral-500">slides {f.relatedSlides.join(", ")}</p>
      )}
    </button>
  );
}
