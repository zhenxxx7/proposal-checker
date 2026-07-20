"use client";

import { useState } from "react";
import { FindingCard } from "./FindingCard";
import { Card, StackedBar, TONE } from "./ui";
import { findingFingerprint, type FeedbackRating, type FeedbackSelections } from "@/lib/feedback";
import { readiness, type Group } from "@/lib/groups";
import type { Finding, Severity } from "@/lib/types";

const BANNER = {
  blocked: {
    title: "Not ready to send",
    body: "Some issues will be visible to the client. Clear the red ones first.",
    accent: "bg-rose-500",
    glow: "from-rose-500/10",
  },
  almost: {
    title: "Almost ready",
    body: "Nothing blocking. Skim the amber items, then send.",
    accent: "bg-amber-500",
    glow: "from-amber-500/10",
  },
  ready: {
    title: "Ready to send",
    body: "No blocking or review-level issues found.",
    accent: "bg-emerald-500",
    glow: "from-emerald-500/10",
  },
} as const;

const LABEL: Record<Severity, string> = { error: "Must fix", warn: "Should check", info: "Minor" };

export function Summary({
  all,
  groups,
  slideCount,
  query,
  onOpen,
  feedback,
  onFeedback,
}: {
  /** the whole deck — the verdict must not change when the user searches */
  all: Finding[];
  /** already filtered by the search box */
  groups: Group[];
  slideCount: number;
  query: string;
  onOpen: (f: Finding) => void;
  feedback: FeedbackSelections;
  onFeedback: (finding: Finding, rating: FeedbackRating) => void;
}) {
  const state = readiness(all);
  const b = BANNER[state];
  const counts: Record<Severity, number> = {
    error: all.filter((f) => f.severity === "error").length,
    warn: all.filter((f) => f.severity === "warn").length,
    info: all.filter((f) => f.severity === "info").length,
  };
  const shown = groups.reduce((n, g) => n + g.findings.length, 0);
  const searching = query.trim().length > 0;

  return (
    <div className="rise mx-auto w-full max-w-3xl space-y-4 pb-20">
      <Card data-readiness={state} className={`relative overflow-hidden bg-gradient-to-b ${b.glow} to-transparent p-6`}>
        <div className="flex items-center gap-2.5">
          <span className={`h-2 w-2 rounded-full ${b.accent}`} />
          <h2 className="text-xl font-semibold tracking-tight">{b.title}</h2>
        </div>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{b.body}</p>

        <div className="mt-5">
          <StackedBar counts={counts} />
        </div>

        <div className="mt-4 grid grid-cols-3 gap-3">
          {(["error", "warn", "info"] as const).map((s) => (
            <div key={s} className="rounded-lg border border-zinc-200/80 px-3 py-2.5 dark:border-zinc-800">
              <p
                data-stat={s}
                className={`text-2xl font-semibold tabular-nums ${counts[s] ? TONE[s].text : "text-zinc-300 dark:text-zinc-700"}`}
              >
                {counts[s]}
              </p>
              <p className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400">{LABEL[s]}</p>
            </div>
          ))}
        </div>

        <p className="mt-3 text-xs text-zinc-400">
          {all.length} findings across {slideCount} slides
          {searching && ` · showing ${shown} matching “${query.trim()}”`}
        </p>
      </Card>

      {groups.length === 0 && (
        <Card className="border-dashed p-12 text-center">
          <p className="text-sm text-zinc-500">
            {searching
              ? `No findings match “${query.trim()}”.`
              : "Nothing to report. Run the AI deep check for typos hidden inside mockup images."}
          </p>
        </Card>
      )}

      <div className="space-y-2.5">
        {groups.map((g, i) => (
          // Expand what needs attention. A deck with no blocking issues would
          // otherwise land on a wall of collapsed rows, so open the top group.
          <GroupCard
            key={g.key}
            g={g}
            defaultOpen={g.severity === "error" || i === 0}
            onOpen={onOpen}
            feedback={feedback}
            onFeedback={onFeedback}
          />
        ))}
      </div>
    </div>
  );
}

function GroupCard({
  g,
  defaultOpen,
  onOpen,
  feedback,
  onFeedback,
}: {
  g: Group;
  defaultOpen: boolean;
  onOpen: (f: Finding) => void;
  feedback: FeedbackSelections;
  onFeedback: (finding: Finding, rating: FeedbackRating) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const tone = TONE[g.severity];

  return (
    <Card data-group={g.key} className="overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3.5 px-4 py-3.5 text-left transition hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
      >
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg text-base ${tone.soft}`}>{g.icon}</span>

        <span className="min-w-0 flex-1">
          <span data-group-title className="block truncate text-[14px] font-semibold text-zinc-900 dark:text-zinc-100">
            {g.title}
          </span>
          {g.why && <span className="mt-0.5 block truncate text-xs text-zinc-500">{g.why}</span>}
        </span>

        <span className="hidden shrink-0 text-[11px] tabular-nums text-zinc-400 sm:block">
          {g.slides.length > 6 ? `${g.slides.length} slides` : `slide ${g.slides.join(", ")}`}
        </span>

        <svg
          viewBox="0 0 20 20"
          aria-hidden
          className={`h-4 w-4 shrink-0 text-zinc-400 transition-transform ${open ? "rotate-90" : ""}`}
        >
          <path d="m7 4 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div className="divide-y divide-zinc-100 border-t border-zinc-100 dark:divide-zinc-800 dark:border-zinc-800">
          {g.findings.map((f) => (
            <FindingCard
              key={f.id}
              f={f}
              active={false}
              feedback={feedback[findingFingerprint(f)]}
              onFeedback={onFeedback}
              onClick={() => onOpen(f)}
            />
          ))}
        </div>
      )}
    </Card>
  );
}
