"use client";

import type { Severity } from "@/lib/types";

// ---------------------------------------------------------------- severity

export const TONE: Record<Severity, { dot: string; bar: string; text: string; soft: string; ring: string }> = {
  error: {
    dot: "bg-rose-500",
    bar: "bg-rose-500",
    text: "text-rose-600 dark:text-rose-400",
    soft: "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300",
    ring: "ring-rose-500/20",
  },
  warn: {
    dot: "bg-amber-500",
    bar: "bg-amber-500",
    text: "text-amber-600 dark:text-amber-400",
    soft: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300",
    ring: "ring-amber-500/20",
  },
  info: {
    dot: "bg-sky-500",
    bar: "bg-sky-500",
    text: "text-sky-600 dark:text-sky-400",
    soft: "bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300",
    ring: "ring-sky-500/20",
  },
};

// ---------------------------------------------------------------- primitives

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
};

export function Button({ variant = "secondary", className = "", ...rest }: ButtonProps) {
  const base =
    "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500";
  const look = {
    primary: "bg-indigo-600 text-white shadow-sm hover:bg-indigo-500 active:bg-indigo-700",
    secondary:
      "border border-zinc-200 bg-white text-zinc-700 shadow-sm hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800",
    ghost: "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100",
  }[variant];
  return <button className={`${base} ${look} ${className}`} {...rest} />;
}

export function Card({ className = "", ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900 ${className}`}
      {...rest}
    />
  );
}

export function Chip({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-md bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300 ${className}`}
    >
      {children}
    </span>
  );
}

export function Tabs<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex rounded-lg border border-zinc-200 bg-white p-0.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      {options.map((o) => (
        <button
          key={o}
          onClick={() => onChange(o)}
          className={`rounded-[5px] px-3 py-1 text-[13px] font-medium capitalize transition ${
            value === o
              ? "bg-zinc-900 text-white shadow-sm dark:bg-zinc-100 dark:text-zinc-900"
              : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
          }`}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

export function SearchInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative">
      <svg
        viewBox="0 0 20 20"
        aria-hidden
        className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400"
      >
        <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="m13 13 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search findings…"
        className="w-48 rounded-lg border border-zinc-200 bg-white py-1.5 pl-8 pr-2.5 text-[13px] shadow-sm outline-none placeholder:text-zinc-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 dark:border-zinc-800 dark:bg-zinc-900"
      />
    </div>
  );
}

/** Proportional severity bar — reads faster than three numbers. */
export function StackedBar({ counts }: { counts: Record<Severity, number> }) {
  const total = counts.error + counts.warn + counts.info;
  if (!total) return <div className="h-1.5 rounded-full bg-emerald-500" />;
  return (
    <div className="flex h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
      {(["error", "warn", "info"] as const).map((s) =>
        counts[s] ? (
          <div key={s} className={TONE[s].bar} style={{ width: `${(counts[s] / total) * 100}%` }} />
        ) : null,
      )}
    </div>
  );
}

// ---------------------------------------------------------------- theme

/**
 * No React state: the `dark` class on <html> is the single source of truth, and
 * CSS picks the icon. Keeps SSR and the pre-paint theme script from disagreeing.
 */
export function ThemeToggle() {
  const toggle = () => {
    const next = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
  };

  return (
    <Button variant="ghost" onClick={toggle} aria-label="Toggle theme" className="px-2">
      {/* sun shows in dark mode (click → light); moon shows in light mode */}
      <svg viewBox="0 0 20 20" className="hidden h-4 w-4 dark:block" fill="currentColor" aria-hidden>
        <path d="M10 2a1 1 0 0 1 1 1v1a1 1 0 1 1-2 0V3a1 1 0 0 1 1-1Zm0 12a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm7-4a1 1 0 0 1-1 1h-1a1 1 0 1 1 0-2h1a1 1 0 0 1 1 1ZM5 10a1 1 0 0 1-1 1H3a1 1 0 1 1 0-2h1a1 1 0 0 1 1 1Zm10.07-5.07a1 1 0 0 1 0 1.41l-.7.71a1 1 0 1 1-1.42-1.42l.71-.7a1 1 0 0 1 1.41 0ZM7.05 13.66a1 1 0 0 1 0 1.41l-.71.71a1 1 0 0 1-1.41-1.42l.7-.7a1 1 0 0 1 1.42 0Zm7.31 2.12a1 1 0 0 1-1.41 0l-.71-.71a1 1 0 0 1 1.42-1.41l.7.7a1 1 0 0 1 0 1.42ZM6.34 5.64a1 1 0 0 1-1.41 0l-.71-.7a1 1 0 0 1 1.42-1.42l.7.71a1 1 0 0 1 0 1.41ZM10 16a1 1 0 0 1 1 1v1a1 1 0 1 1-2 0v-1a1 1 0 0 1 1-1Z" />
      </svg>
      <svg viewBox="0 0 20 20" className="h-4 w-4 dark:hidden" fill="currentColor" aria-hidden>
        <path d="M17.29 12.71A8 8 0 0 1 7.29 2.71a8.001 8.001 0 1 0 10 10Z" />
      </svg>
    </Button>
  );
}
