"use client";

import { useEffect, useRef, useState } from "react";
import { SlidePreview } from "./SlidePreview";
import { TONE } from "./ui";
import type { Deck, Finding, Severity } from "@/lib/types";

export function SlideRail({
  deck,
  urls,
  counts,
  current,
  onPick,
}: {
  deck: Deck;
  urls: Map<string, string>;
  counts: Map<number, Record<Severity, number>>;
  current: number;
  onPick: (n: number) => void;
}) {
  return (
    <nav className="flex max-h-[calc(100vh-9.5rem)] flex-col gap-2 overflow-y-auto pr-1">
      {deck.slides.map((s) => (
        <Thumb key={s.index} active={s.index === current} count={counts.get(s.index)} label={s.index} onClick={() => onPick(s.index)}>
          <SlidePreview deck={deck} slide={s} urls={urls} variant="thumb" />
        </Thumb>
      ))}
    </nav>
  );
}

/** Mount the preview only once the thumb scrolls into view — 93 slides × 355 images otherwise. */
function Thumb({
  active,
  count,
  label,
  onClick,
  children,
}: {
  active: boolean;
  count?: Record<Severity, number>;
  label: number;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);

  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const worst: Severity | null = count?.error ? "error" : count?.warn ? "warn" : count?.info ? "info" : null;
  const total = count ? count.error + count.warn + count.info : 0;

  return (
    <button
      ref={ref}
      onClick={onClick}
      className={`group relative shrink-0 overflow-hidden rounded-lg border bg-white transition dark:bg-zinc-900 ${
        active
          ? "border-indigo-500 ring-2 ring-indigo-500/30"
          : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700"
      }`}
    >
      <div className="aspect-video w-full bg-white">{seen ? children : null}</div>

      <span
        className={`absolute left-1 top-1 rounded px-1 py-px text-[10px] font-semibold tabular-nums backdrop-blur ${
          active ? "bg-indigo-600 text-white" : "bg-black/45 text-white"
        }`}
      >
        {label}
      </span>

      {worst && (
        <span className={`absolute right-1 top-1 flex items-center gap-0.5 rounded px-1 py-px text-[10px] font-semibold text-white backdrop-blur ${
          worst === "error" ? "bg-rose-500/90" : worst === "warn" ? "bg-amber-500/90" : "bg-sky-500/90"
        }`}>
          {total}
        </span>
      )}
      {worst && <span className={`absolute inset-x-0 bottom-0 h-0.5 ${TONE[worst].bar}`} />}
    </button>
  );
}

export function countBySlide(findings: Finding[]) {
  const m = new Map<number, Record<Severity, number>>();
  for (const f of findings) {
    const e = m.get(f.slide) ?? m.set(f.slide, { error: 0, warn: 0, info: 0 }).get(f.slide)!;
    e[f.severity]++;
  }
  return m;
}
