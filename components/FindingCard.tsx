"use client";

import { useState } from "react";
import { Chip, TONE } from "./ui";
import type { Finding } from "@/lib/types";

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
  const tone = TONE[f.severity];

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
      data-finding={f.id}
      data-severity={f.severity}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onClick()}
      className={`group relative cursor-pointer px-4 py-3 transition ${
        active ? "bg-indigo-50/60 dark:bg-indigo-500/10" : "hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
      }`}
    >
      <div className="flex items-start gap-2.5">
        <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <p className="text-[13px] font-semibold leading-snug text-zinc-900 dark:text-zinc-100">{f.title}</p>
            {showSlide && <Chip className="mt-px shrink-0">slide {f.slide}</Chip>}
          </div>

          <p className="mt-1 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{f.detail}</p>

          {f.quote && (
            <p className="mt-2 truncate rounded-md bg-zinc-100 px-2 py-1 font-mono text-[11px] text-zinc-700 dark:bg-zinc-800/80 dark:text-zinc-300">
              {f.quote}
            </p>
          )}

          {f.suggestion && (
            <div className="mt-1.5 flex items-center gap-2">
              <p className="min-w-0 flex-1 truncate text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                {f.suggestion}
              </p>
              <button
                onClick={copy}
                className="shrink-0 rounded-md border border-zinc-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 opacity-0 transition group-hover:opacity-100 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
              >
                {copied ? "copied" : "copy"}
              </button>
            </div>
          )}

          {!!f.relatedSlides?.length && f.relatedSlides.length > 1 && (
            <p className="mt-1.5 text-[11px] text-zinc-400">
              also on slides {f.relatedSlides.slice(0, 12).join(", ")}
              {f.relatedSlides.length > 12 && ` +${f.relatedSlides.length - 12}`}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
