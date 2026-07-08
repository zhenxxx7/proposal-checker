"use client";

import { useState } from "react";
import { Card } from "./ui";

const CHECKS = [
  ["🔍", "Blurry images", "Effective DPI, accounting for crops and rotation"],
  ["↔️", "Stretched images", "Aspect ratio measured against the source pixels"],
  ["📐", "Inconsistent sizing", "Side-by-side images that almost match"],
  ["🔤", "Terminology drift", "“Back End” vs “Backend” across slides"],
  ["✏️", "Typos & placeholders", "Repeated words, lorem ipsum, TBD"],
  ["🖼️", "Text inside mockups", "AI reads the screenshots (optional)"],
] as const;

export function Dropzone({ busy, onFile }: { busy: boolean; onFile: (f: File) => void }) {
  const [over, setOver] = useState(false);
  const [rejected, setRejected] = useState(false);

  const take = (f: File | undefined) => {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".pptx")) {
      setRejected(true);
      setTimeout(() => setRejected(false), 2600);
      return;
    }
    onFile(f);
  };

  return (
    <div className="rise mx-auto w-full max-w-2xl py-6">
      <div className="mb-8 text-center">
        <h2 className="text-2xl font-semibold tracking-tight">Check a proposal before you send it</h2>
        <p className="mx-auto mt-2 max-w-lg text-sm text-zinc-500">
          Typos, blurry images, and sizing that is almost consistent — including text baked into mockup screenshots.
        </p>
      </div>

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
        className={`flex min-h-[15rem] cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed bg-white p-10 text-center transition dark:bg-zinc-900/50 ${
          over
            ? "border-indigo-500 bg-indigo-50/60 dark:bg-indigo-500/5"
            : rejected
              ? "border-rose-400"
              : "border-zinc-300 hover:border-zinc-400 dark:border-zinc-700 dark:hover:border-zinc-600"
        }`}
      >
        <input type="file" accept=".pptx" className="hidden" disabled={busy} onChange={(e) => take(e.target.files?.[0])} />

        {busy ? (
          <>
            <Spinner />
            <p className="text-base font-medium">Reading the deck…</p>
            <p className="text-sm text-zinc-500">Unzipping slides and measuring every image.</p>
          </>
        ) : (
          <>
            <span className="grid h-12 w-12 place-items-center rounded-xl bg-zinc-100 dark:bg-zinc-800">
              <svg viewBox="0 0 24 24" className="h-5 w-5 text-zinc-500" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M12 16V4m0 0L8 8m4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" strokeLinecap="round" />
              </svg>
            </span>
            <p className="text-base font-medium">
              {rejected ? "That is not a .pptx file" : "Drop a .pptx proposal here"}
            </p>
            <p className="text-sm text-zinc-500">or click to choose a file</p>
            <p className="mt-2 max-w-md text-xs leading-relaxed text-zinc-400">
              Parsed entirely in your browser. The deck is never uploaded — a 140MB file stays on this machine.
            </p>
          </>
        )}
      </label>

      <Card className="mt-6 grid gap-x-6 gap-y-4 p-5 sm:grid-cols-2">
        {CHECKS.map(([icon, title, sub]) => (
          <div key={title} className="flex gap-3">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-zinc-100 text-sm dark:bg-zinc-800">
              {icon}
            </span>
            <div className="min-w-0">
              <p className="text-[13px] font-medium">{title}</p>
              <p className="mt-0.5 text-xs leading-snug text-zinc-500">{sub}</p>
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

const Spinner = () => (
  <span className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-200 border-t-indigo-600 dark:border-zinc-700 dark:border-t-indigo-400" />
);
