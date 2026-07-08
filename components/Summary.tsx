"use client";

import { useState } from "react";
import { FindingCard } from "./FindingCard";
import { readiness, type Group } from "@/lib/groups";
import type { Finding, Severity } from "@/lib/types";

const BANNER = {
  blocked: {
    title: "Not ready to send",
    body: "Some issues will be visible to the client. Fix the red ones first.",
    cls: "border-rose-300 bg-rose-50 dark:border-rose-900/60 dark:bg-rose-950/30",
    dot: "bg-rose-500",
  },
  almost: {
    title: "Almost ready",
    body: "Nothing blocking. Skim the amber items, then send.",
    cls: "border-amber-300 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/30",
    dot: "bg-amber-500",
  },
  ready: {
    title: "Ready to send",
    body: "No blocking or review-level issues found.",
    cls: "border-emerald-300 bg-emerald-50 dark:border-emerald-900/60 dark:bg-emerald-950/30",
    dot: "bg-emerald-500",
  },
} as const;

const RING: Record<Severity, string> = {
  error: "text-rose-600 dark:text-rose-400",
  warn: "text-amber-600 dark:text-amber-400",
  info: "text-sky-600 dark:text-sky-400",
};

export function Summary({
  all,
  groups,
  slideCount,
  query,
  onOpen,
}: {
  /** the whole deck — the verdict must not change when the user searches */
  all: Finding[];
  /** already filtered by the search box */
  groups: Group[];
  slideCount: number;
  query: string;
  onOpen: (f: Finding) => void;
}) {
  const state = readiness(all);
  const b = BANNER[state];
  const counts = {
    error: all.filter((f) => f.severity === "error").length,
    warn: all.filter((f) => f.severity === "warn").length,
    info: all.filter((f) => f.severity === "info").length,
  };
  const shown = groups.reduce((n, g) => n + g.findings.length, 0);
  const searching = query.trim().length > 0;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 pb-16">
      <div className={`rounded-xl border p-5 ${b.cls}`}>
        <div className="flex items-center gap-2.5">
          <span className={`h-2.5 w-2.5 rounded-full ${b.dot}`} />
          <h2 className="text-lg font-semibold tracking-tight">{b.title}</h2>
        </div>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">{b.body}</p>

        <div className="mt-4 grid grid-cols-3 divide-x divide-neutral-300/60 rounded-lg border border-neutral-300/60 bg-white/60 dark:divide-neutral-800 dark:border-neutral-800 dark:bg-black/20">
          <Stat n={counts.error} label="must fix" tone="error" />
          <Stat n={counts.warn} label="should check" tone="warn" />
          <Stat n={counts.info} label="minor" tone="info" />
        </div>
        <p className="mt-2.5 text-xs text-neutral-500">
          {all.length} findings across {slideCount} slides
          {searching && ` · showing ${shown} matching “${query.trim()}”`}
        </p>
      </div>

      {groups.length === 0 && (
        <p className="rounded-xl border border-dashed border-neutral-300 p-10 text-center text-sm text-neutral-500 dark:border-neutral-800">
          {searching
            ? `No findings match “${query.trim()}”.`
            : "Nothing to report. Run the AI deep check for typos hidden inside mockup images."}
        </p>
      )}

      <div className="space-y-2.5">
        {groups.map((g) => (
          <GroupCard key={g.key} g={g} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}

function Stat({ n, label, tone }: { n: number; label: string; tone: Severity }) {
  return (
    <div className="px-3 py-2.5 text-center">
      <p className={`text-2xl font-semibold tabular-nums ${n ? RING[tone] : "text-neutral-400"}`}>{n}</p>
      <p className="text-[11px] uppercase tracking-wide text-neutral-500">{label}</p>
    </div>
  );
}

function GroupCard({ g, onOpen }: { g: Group; onOpen: (f: Finding) => void }) {
  const [open, setOpen] = useState(g.severity === "error");
  const border =
    g.severity === "error"
      ? "border-l-rose-500"
      : g.severity === "warn"
        ? "border-l-amber-500"
        : "border-l-sky-500";

  return (
    <section className={`overflow-hidden rounded-lg border border-l-[5px] border-neutral-200 dark:border-neutral-800 ${border}`}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-neutral-50 dark:hover:bg-neutral-900/50"
      >
        <span className="text-lg leading-none">{g.icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">{g.title}</span>
          {g.why && <span className="block text-xs text-neutral-500">{g.why}</span>}
        </span>
        <span className="hidden shrink-0 text-[11px] text-neutral-500 sm:block">
          {g.slides.length > 6
            ? `${g.slides.length} slides`
            : `slide ${g.slides.join(", ")}`}
        </span>
        <span className={`shrink-0 text-neutral-400 transition ${open ? "rotate-90" : ""}`}>›</span>
      </button>

      {open && (
        <div className="divide-y divide-neutral-100 border-t border-neutral-100 dark:divide-neutral-900 dark:border-neutral-900">
          {g.findings.map((f) => (
            <FindingCard key={f.id} f={f} active={false} onClick={() => onOpen(f)} />
          ))}
        </div>
      )}
    </section>
  );
}
