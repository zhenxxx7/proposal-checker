"use client";

import { useState } from "react";

const CHECKS = [
  ["🔍", "Blurry images", "Effective DPI, accounting for crops and rotation"],
  ["↔️", "Stretched images", "Aspect ratio vs the source pixels"],
  ["📐", "Inconsistent sizing", "Side-by-side images that almost match"],
  ["🔤", "Terminology drift", "“Back End” vs “Backend” across slides"],
  ["✏️", "Typos & placeholders", "Repeated words, lorem ipsum, TBD"],
  ["🖼️", "Text inside mockups", "AI reads the screenshots (optional)"],
] as const;

export function Dropzone({ busy, onFile }: { busy: boolean; onFile: (f: File) => void }) {
  const [over, setOver] = useState(false);

  const take = (f: File | undefined) => {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".pptx")) return;
    onFile(f);
  };

  return (
    <div className="mx-auto w-full max-w-3xl">
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          take(e.dataTransfer.files[0]);
        }}
        className={`flex min-h-[16rem] cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-10 text-center transition ${
          over
            ? "border-neutral-900 bg-neutral-50 dark:border-white dark:bg-neutral-900"
            : "border-neutral-300 hover:border-neutral-400 dark:border-neutral-700"
        }`}
      >
        <input
          type="file"
          accept=".pptx"
          className="hidden"
          disabled={busy}
          onChange={(e) => take(e.target.files?.[0])}
        />
        {busy ? (
          <>
            <Spinner />
            <p className="text-lg font-medium">Reading the deck…</p>
            <p className="text-sm text-neutral-500">Unzipping slides and measuring every image.</p>
          </>
        ) : (
          <>
            <p className="text-lg font-medium">Drop a .pptx proposal here</p>
            <p className="text-sm text-neutral-500">or click to choose a file</p>
            <p className="mt-3 max-w-md text-xs leading-relaxed text-neutral-500">
              Parsed entirely in your browser. The deck is never uploaded — a 140MB file stays on this machine.
            </p>
          </>
        )}
      </label>

      <div className="mt-6 grid gap-x-6 gap-y-3 sm:grid-cols-2">
        {CHECKS.map(([icon, title, sub]) => (
          <div key={title} className="flex gap-2.5">
            <span className="mt-0.5 text-base leading-none">{icon}</span>
            <div className="min-w-0">
              <p className="text-[13px] font-medium">{title}</p>
              <p className="text-xs leading-snug text-neutral-500">{sub}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const Spinner = () => (
  <span className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-900 dark:border-neutral-700 dark:border-t-white" />
);
