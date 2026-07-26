"use client";

import { useState } from "react";
import { Chip, TONE } from "./ui";
import { isAiFinding, type FeedbackRating, type FeedbackSelection } from "@/lib/feedback";
import type { Finding } from "@/lib/types";

export function FindingCard({
  f,
  active,
  showSlide = true,
  onClick,
  feedback,
  onFeedback,
}: {
  f: Finding;
  active: boolean;
  showSlide?: boolean;
  onClick: () => void;
  feedback?: FeedbackSelection;
  onFeedback?: (finding: Finding, rating: FeedbackRating) => void;
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

          {isAiFinding(f) && onFeedback && (
            <div
              className="mt-2 flex flex-wrap items-center gap-2"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <label className="flex items-center gap-1.5 text-[10px] font-medium text-zinc-500 dark:text-zinc-400">
                <span>AI feedback</span>
                <select
                  aria-label={`Rate AI finding: ${f.title}`}
                  data-feedback-rating={f.source}
                  value={feedback?.rating ?? ""}
                  onChange={(event) => onFeedback(f, event.target.value as FeedbackRating)}
                  className="rounded-md border border-zinc-200 bg-white px-1.5 py-1 text-[11px] text-zinc-700 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:focus:border-indigo-500 dark:focus:ring-indigo-950"
                >
                  <option value="" disabled hidden>
                    Select
                  </option>
                  <option value="useful">Useful</option>
                  <option value="not-useful">Not useful</option>
                </select>
              </label>
              {feedback && (
                <span
                  data-feedback-status={feedback.delivery}
                  title={
                    feedback.delivery === "error"
                      ? "Could not save this selection in browser or shared memory."
                      : undefined
                  }
                  className={`text-[10px] ${
                    feedback.delivery === "error"
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-zinc-400 dark:text-zinc-500"
                  }`}
                >
                  {feedback.delivery === "error"
                    ? "Save failed"
                    : feedback.delivery === "syncing"
                      ? "Saving..."
                      : feedback.delivery === "shared"
                        ? "Shared memory"
                        : "Learned locally"}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
