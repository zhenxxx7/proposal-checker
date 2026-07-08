"use client";

import { useEffect, useRef, useState } from "react";
import { SlidePreview } from "./SlidePreview";
import type { Deck, Finding, Severity } from "@/lib/types";

const DOT: Record<Severity, string> = {
  error: "bg-rose-500",
  warn: "bg-amber-500",
  info: "bg-sky-500",
};

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
    <nav className="flex max-h-[calc(100vh-11rem)] flex-col gap-1.5 overflow-y-auto pr-1">
      {deck.slides.map((s) => (
        <Thumb
          key={s.index}
          active={s.index === current}
          count={counts.get(s.index)}
          onClick={() => onPick(s.index)}
          label={s.index}
        >
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

  const total = count ? count.error + count.warn + count.info : 0;

  return (
    <button
      ref={ref}
      onClick={onClick}
      className={`group relative shrink-0 overflow-hidden rounded-md border text-left transition ${
        active
          ? "border-neutral-900 ring-2 ring-neutral-900 dark:border-white dark:ring-white"
          : "border-neutral-200 hover:border-neutral-400 dark:border-neutral-800"
      }`}
    >
      <div className="aspect-video w-full bg-white">{seen ? children : null}</div>
      <div className="flex items-center justify-between gap-1 px-1.5 py-1 text-[11px]">
        <span className={active ? "font-semibold" : "text-neutral-500"}>{label}</span>
        {total > 0 && (
          <span className="flex items-center gap-0.5">
            {(["error", "warn", "info"] as const).map((s) =>
              count![s] ? <span key={s} className={`h-1.5 w-1.5 rounded-full ${DOT[s]}`} /> : null,
            )}
          </span>
        )}
      </div>
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
