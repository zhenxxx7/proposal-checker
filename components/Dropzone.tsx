"use client";

import { useState } from "react";
import { Button, Card } from "./ui";

const CHECKS = [
  ["🔍", "Blurry images", "Effective DPI, accounting for crops and rotation"],
  ["↔️", "Stretched images", "Aspect ratio measured against the source pixels"],
  ["📐", "Inconsistent sizing", "Side-by-side images that almost match"],
  ["🔤", "Terminology drift", "“Back End” vs “Backend” across slides"],
  ["✏️", "Typos & placeholders", "Repeated words, lorem ipsum, TBD"],
  ["🖼️", "Text inside mockups", "AI reads the screenshots (optional)"],
] as const;

export interface GoogleSlidesStream {
  name: string;
  stream: ReadableStream<Uint8Array>;
  total: number | null;
  reportProgress: (loaded: number) => void;
}

export function Dropzone({
  busy,
  onFile,
  onGoogleSlides,
}: {
  busy: boolean;
  onFile: (file: File) => void | Promise<void>;
  onGoogleSlides: (source: GoogleSlidesStream) => void | Promise<void>;
}) {
  const [over, setOver] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [googleUrl, setGoogleUrl] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState("Connecting to Google Slides...");
  const working = busy || importing;

  const take = (f: File | undefined) => {
    if (!f || working) return;
    if (!f.name.toLowerCase().endsWith(".pptx")) {
      setRejected(true);
      setTimeout(() => setRejected(false), 2600);
      return;
    }
    setLinkError(null);
    void onFile(f);
  };

  const importGoogleSlides = async (e: React.FormEvent) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget as HTMLFormElement);
    const url = String(form.get("url") ?? googleUrl).trim();
    if (!url) {
      setLinkError("Paste a Google Slides share link.");
      return;
    }

    setImporting(true);
    setImportStatus("Connecting to Google Slides...");
    setLinkError(null);
    try {
      const response = await fetch("/api/import-google-slides", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!response.ok) {
        const result = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(result?.error ?? "Could not import this Google Slides link.");
      }

      const totalHeader = Number(response.headers.get("content-length"));
      const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : null;
      const encodedName = response.headers.get("x-file-name");
      let name = "Google Slides presentation.pptx";
      try {
        if (encodedName) name = decodeURIComponent(encodedName);
      } catch {
        // Keep the fallback name.
      }
      if (!response.body) throw new Error("Google Slides returned an empty presentation.");

      setImportStatus("Downloading and reading Google Slides...");
      await onGoogleSlides({
        name,
        stream: response.body,
        total,
        reportProgress: (loaded) => {
          setImportStatus(
            total
              ? `Downloading and reading... ${Math.min(100, Math.round((loaded / total) * 100))}%`
              : `Downloading and reading... ${formatBytes(loaded)}`,
          );
        },
      });
    } catch (error) {
      setLinkError(error instanceof Error ? error.message : "Could not import this Google Slides link.");
    } finally {
      setImporting(false);
    }
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
        <input type="file" accept=".pptx" className="hidden" disabled={working} onChange={(e) => take(e.target.files?.[0])} />

        {working ? (
          <>
            <Spinner />
            <p className="text-base font-medium">{importing ? importStatus : "Reading the deck..."}</p>
            <p className="text-sm text-zinc-500">Keep this tab open while the presentation is prepared.</p>
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
              Local files are parsed in your browser and never uploaded.
            </p>
          </>
        )}
      </label>

      <div className="my-4 flex items-center gap-3 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
        <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
        or Google Slides
        <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
      </div>

      <form noValidate onSubmit={importGoogleSlides} className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <svg
            viewBox="0 0 20 20"
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
          >
            <path d="M8.2 11.8 11.8 8.2" strokeLinecap="round" />
            <path d="M6.4 13.6 5 15a3 3 0 0 1-4.2-4.2l3-3A3 3 0 0 1 8 7.7" strokeLinecap="round" />
            <path d="m13.6 6.4 1.4-1.4a3 3 0 0 1 4.2 4.2l-3 3a3 3 0 0 1-4.2.1" strokeLinecap="round" />
          </svg>
          <input
            data-google-slides-url
            name="url"
            type="text"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={googleUrl}
            onChange={(e) => {
              setGoogleUrl(e.target.value);
              setLinkError(null);
            }}
            placeholder="https://docs.google.com/presentation/d/..."
            disabled={working}
            aria-label="Google Slides link"
            className={`h-10 w-full rounded-md border bg-white pl-9 pr-3 text-[13px] outline-none transition placeholder:text-zinc-400 focus:ring-2 dark:bg-zinc-900 ${
              linkError
                ? "border-rose-400 focus:border-rose-500 focus:ring-rose-500/20"
                : "border-zinc-300 focus:border-indigo-500 focus:ring-indigo-500/20 dark:border-zinc-700"
            }`}
          />
        </div>
        <Button type="submit" variant="primary" disabled={working} className="h-10 shrink-0 px-4">
          {importing ? "Importing" : "Import"}
        </Button>
      </form>
      {linkError && (
        <p role="alert" className="mt-2 text-xs text-rose-600 dark:text-rose-400">
          {linkError}
        </p>
      )}

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

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
