"use client";

import { useState } from "react";
import type { Finding, Severity } from "@/lib/types";

const BAR: Record<Severity, string> = {
  error: "bg-rose-500",
  warn: "bg-amber-500",
  info: "bg-sky-500",
};

export function FindingCard({
  f,
  active,
  showSlide = true,
  onClick,
}: {
  f: Finding;
  active: boolean;
  showSlide?: boolean;
  onClick: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!f.suggestion) return;
    await navigator.clipboard.writeText(f.suggestion);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onClick()}
      className={`relative cursor-pointer px-3.5 py-3 pl-5 transition ${
        active ? "bg-neutral-100 dark:bg-neutral-900" : "hover:bg-neutral-50 dark:hover:bg-neutral-900/50"
      }`}
    >
      <span className={`absolute left-0 top-0 h-full w-1 ${BAR[f.severity]}`} />

      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] font-semibold leading-snug">{f.title}</p>
        {showSlide && (
          <span className="mt-0.5 shrink-0 rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
            slide {f.slide}
          </span>
        )}
      </div>

      <p className="mt-1 text-xs leading-relaxed text-neutral-600 dark:text-neutral-400">{f.detail}</p>

      {f.quote && (
        <p className="mt-2 truncate rounded bg-neutral-100 px-2 py-1 font-mono text-[11px] text-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
          {f.quote}
        </p>
      )}

      {f.suggestion && (
        <div className="mt-1.5 flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-[11px] text-emerald-700 dark:text-emerald-400">
            → {f.suggestion}
          </p>
          <button
            onClick={copy}
            className="shrink-0 rounded border border-neutral-300 px-1.5 py-0.5 text-[10px] text-neutral-600 hover:bg-white dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
          >
            {copied ? "copied" : "copy"}
          </button>
        </div>
      )}

      {!!f.relatedSlides?.length && f.relatedSlides.length > 1 && (
        <p className="mt-1.5 text-[11px] text-neutral-500">also on slides {f.relatedSlides.slice(0, 12).join(", ")}</p>
      )}
    </div>
  );
}
