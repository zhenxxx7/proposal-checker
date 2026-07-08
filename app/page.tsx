"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FindingCard } from "@/components/FindingCard";
import { SlidePreview } from "@/components/SlidePreview";
import { analyzeImages, analyzeText, selectImageJobs } from "@/lib/aiClient";
import { runRuleChecks } from "@/lib/checks";
import { parsePptx } from "@/lib/pptx";
import { bySeverity, download, tally, toMarkdown } from "@/lib/report";
import type { Deck, Finding, Severity, Source } from "@/lib/types";

type Phase = "idle" | "parsing" | "ready" | "ai";

const SEVERITIES: Severity[] = ["error", "warn", "info"];
const SOURCES: Source[] = ["rule", "ai-text", "ai-image"];
const SOURCE_LABEL: Record<Source, string> = { rule: "Rules", "ai-text": "AI text", "ai-image": "AI images" };
const SEV_LABEL: Record<Severity, string> = { error: "Blocking", warn: "Review", info: "Minor" };

export default function Page() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [fileName, setFileName] = useState("");
  const [deck, setDeck] = useState<Deck | null>(null);
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  const [findings, setFindings] = useState<Finding[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0, label: "" });

  const [slide, setSlide] = useState(1);
  const [active, setActive] = useState<string | null>(null);
  const [sevOn, setSevOn] = useState<Set<Severity>>(new Set(SEVERITIES));
  const [srcOn, setSrcOn] = useState<Set<Source>>(new Set(SOURCES));
  const [onlyThisSlide, setOnlyThisSlide] = useState(false);

  // Revokes the *previous* map when `urls` is replaced, and everything on unmount.
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);

  const load = useCallback(async (file: File) => {
    setPhase("parsing");
    setError(null);
    setFindings([]);
    setDeck(null);
    setUrls(new Map());
    setFileName(file.name);
    // Let the "parsing" frame paint before we block the thread on unzip.
    await new Promise((r) => setTimeout(r, 30));

    try {
      const parsed = parsePptx(await file.arrayBuffer());
      const next = new Map<string, string>();
      for (const [path, blob] of parsed.blobs) next.set(path, URL.createObjectURL(blob));
      setUrls(next);
      setDeck(parsed);
      setFindings(runRuleChecks(parsed));
      setSlide(1);
      setPhase("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that file.");
      setPhase("idle");
    }
  }, []);

  const imageJobs = useMemo(() => (deck ? selectImageJobs(deck) : []), [deck]);

  const runAi = useCallback(async () => {
    if (!deck) return;
    setPhase("ai");
    setError(null);
    setFindings((f) => f.filter((x) => x.source === "rule"));

    try {
      setProgress({ done: 0, total: imageJobs.length + 1, label: "Proofreading slide text…" });
      const text = await analyzeText(deck);
      setFindings((f) => [...f, ...text]);
      setProgress({ done: 1, total: imageJobs.length + 1, label: "Reading text inside images…" });

      const images = await analyzeImages(imageJobs, (done, total) =>
        setProgress({ done: done + 1, total: total + 1, label: `Reading images ${done}/${total}…` }),
      );
      setFindings((f) => [...f, ...images]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "AI check failed.");
    } finally {
      setPhase("ready");
      setProgress({ done: 0, total: 0, label: "" });
    }
  }, [deck, imageJobs]);

  const visible = useMemo(
    () =>
      findings
        .filter((f) => sevOn.has(f.severity) && srcOn.has(f.source))
        .filter((f) => !onlyThisSlide || f.slide === slide || f.relatedSlides?.includes(slide))
        .sort((a, b) => a.slide - b.slide || bySeverity(a, b)),
    [findings, sevOn, srcOn, onlyThisSlide, slide],
  );

  const perSlide = useMemo(() => {
    const m = new Map<number, { error: number; warn: number; info: number }>();
    for (const f of findings) {
      const e = m.get(f.slide) ?? m.set(f.slide, { error: 0, warn: 0, info: 0 }).get(f.slide)!;
      e[f.severity]++;
    }
    return m;
  }, [findings]);

  const counts = tally(findings);
  const current = deck?.slides.find((s) => s.index === slide);
  const highlight = new Set(findings.find((f) => f.id === active)?.shapeIds ?? []);

  return (
    <main className="mx-auto flex min-h-screen max-w-[1600px] flex-col gap-4 p-4 md:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Proposal Checker</h1>
          <p className="text-sm text-neutral-500">
            Typos, image resolution, and inconsistent sizing — including text inside mockups.
          </p>
        </div>
        {deck && (
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone="error">{counts.error} blocking</Pill>
            <Pill tone="warn">{counts.warn} review</Pill>
            <Pill tone="info">{counts.info} minor</Pill>
            <button
              onClick={() =>
                download(`${fileName}.check.md`, toMarkdown(fileName, deck.slides.length, findings), "text/markdown")
              }
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              Export report
            </button>
            <button
              onClick={runAi}
              disabled={phase === "ai"}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
            >
              {phase === "ai" ? progress.label || "Running…" : `Deep check with AI (${imageJobs.length} images)`}
            </button>
          </div>
        )}
      </header>

      {!deck && <Dropzone phase={phase} onFile={load} />}
      {error && (
        <p className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200">
          {error}
        </p>
      )}

      {phase === "ai" && progress.total > 0 && (
        <div className="h-1 w-full overflow-hidden rounded bg-neutral-200 dark:bg-neutral-800">
          <div
            className="h-full bg-neutral-900 transition-all dark:bg-white"
            style={{ width: `${(progress.done / progress.total) * 100}%` }}
          />
        </div>
      )}

      {deck && current && (
        <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-[9rem_1fr_26rem]">
          <nav className="flex max-h-[80vh] flex-row gap-1 overflow-auto lg:flex-col">
            {deck.slides.map((s) => {
              const c = perSlide.get(s.index);
              return (
                <button
                  key={s.index}
                  onClick={() => setSlide(s.index)}
                  className={`flex shrink-0 items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-sm ${
                    s.index === slide
                      ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
                      : "hover:bg-neutral-100 dark:hover:bg-neutral-900"
                  }`}
                >
                  <span>Slide {s.index}</span>
                  <span className="flex gap-1 text-[10px]">
                    {!!c?.error && <Dot className="bg-rose-500">{c.error}</Dot>}
                    {!!c?.warn && <Dot className="bg-amber-500">{c.warn}</Dot>}
                    {!!c?.info && <Dot className="bg-sky-500">{c.info}</Dot>}
                  </span>
                </button>
              );
            })}
          </nav>

          <section className="min-w-0">
            <SlidePreview
              deck={deck}
              slide={current}
              urls={urls}
              highlight={highlight}
              onPick={() => setActive(null)}
            />
            <p className="mt-2 text-xs text-neutral-500">
              Approximate reconstruction from the slide geometry — click a finding to highlight the shape it refers to.
            </p>
          </section>

          <aside className="flex max-h-[80vh] flex-col overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
            <div className="flex flex-wrap gap-1.5 border-b border-neutral-200 p-2 dark:border-neutral-800">
              {SEVERITIES.map((s) => (
                <Toggle key={s} on={sevOn.has(s)} onClick={() => setSevOn(toggle(sevOn, s))}>
                  {SEV_LABEL[s]}
                </Toggle>
              ))}
              {SOURCES.map((s) => (
                <Toggle key={s} on={srcOn.has(s)} onClick={() => setSrcOn(toggle(srcOn, s))}>
                  {SOURCE_LABEL[s]}
                </Toggle>
              ))}
              <Toggle on={onlyThisSlide} onClick={() => setOnlyThisSlide((v) => !v)}>
                This slide only
              </Toggle>
            </div>
            <div className="flex-1 divide-y divide-neutral-200 overflow-auto dark:divide-neutral-800">
              {visible.length === 0 && (
                <p className="p-6 text-center text-sm text-neutral-500">Nothing matches these filters.</p>
              )}
              {visible.map((f) => (
                <FindingCard
                  key={f.id}
                  f={f}
                  active={f.id === active}
                  onClick={() => {
                    setActive(f.id);
                    setSlide(f.slide);
                  }}
                />
              ))}
            </div>
          </aside>
        </div>
      )}
    </main>
  );
}

function Dropzone({ phase, onFile }: { phase: Phase; onFile: (f: File) => void }) {
  const [over, setOver] = useState(false);
  const busy = phase === "parsing";

  return (
    <label
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files[0];
        if (f) onFile(f);
      }}
      className={`flex min-h-[50vh] cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-10 text-center transition ${
        over
          ? "border-neutral-900 bg-neutral-50 dark:border-white dark:bg-neutral-900"
          : "border-neutral-300 dark:border-neutral-700"
      }`}
    >
      <input
        type="file"
        accept=".pptx"
        className="hidden"
        disabled={busy}
        onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
      />
      <p className="text-lg font-medium">{busy ? "Reading deck…" : "Drop a .pptx proposal here"}</p>
      <p className="max-w-md text-sm text-neutral-500">
        {busy
          ? "Unzipping slides and measuring every image."
          : "The file is parsed in your browser — nothing leaves the machine until you run the AI deep check, and then only downscaled images."}
      </p>
    </label>
  );
}

function toggle<T>(set: Set<T>, v: T) {
  const next = new Set(set);
  if (next.has(v)) next.delete(v);
  else next.add(v);
  return next;
}

const Toggle = ({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) => (
  <button
    onClick={onClick}
    className={`rounded-full px-2.5 py-1 text-xs transition ${
      on
        ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
        : "bg-neutral-100 text-neutral-500 dark:bg-neutral-900"
    }`}
  >
    {children}
  </button>
);

const Pill = ({ tone, children }: { tone: Severity; children: React.ReactNode }) => (
  <span
    className={`rounded-full px-2.5 py-1 text-xs font-medium ${
      tone === "error"
        ? "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200"
        : tone === "warn"
          ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200"
          : "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200"
    }`}
  >
    {children}
  </span>
);

const Dot = ({ className, children }: { className: string; children: React.ReactNode }) => (
  <span className={`inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-white ${className}`}>
    {children}
  </span>
);
