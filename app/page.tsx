"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Dropzone } from "@/components/Dropzone";
import { FindingCard } from "@/components/FindingCard";
import { SlidePreview } from "@/components/SlidePreview";
import { SlideRail, countBySlide } from "@/components/SlideRail";
import { Summary } from "@/components/Summary";
import { analyzeImages, analyzeText, selectImageJobs } from "@/lib/aiClient";
import { runRuleChecks } from "@/lib/checks";
import { groupFindings } from "@/lib/groups";
import { parsePptx } from "@/lib/pptx";
import { bySeverity, download, toMarkdown } from "@/lib/report";
import type { Deck, Finding } from "@/lib/types";

type Phase = "idle" | "parsing" | "ready" | "ai";
type View = "summary" | "slides";

export default function Page() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [view, setView] = useState<View>("summary");
  const [fileName, setFileName] = useState("");
  const [deck, setDeck] = useState<Deck | null>(null);
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  const [findings, setFindings] = useState<Finding[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0, label: "" });
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [aiDone, setAiDone] = useState(false);

  const [slide, setSlide] = useState(1);
  const [active, setActive] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // Revokes the *previous* map when `urls` is replaced, and everything on unmount.
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then((j: { hasKey: boolean }) => setHasKey(j.hasKey))
      .catch(() => setHasKey(false));
  }, []);

  const load = useCallback(async (file: File) => {
    setPhase("parsing");
    setError(null);
    setFindings([]);
    setDeck(null);
    setUrls(new Map());
    setAiDone(false);
    setActive(null);
    setQuery("");
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
      setView("summary");
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
      const total = imageJobs.length + 1;
      setProgress({ done: 0, total, label: "Proofreading slide text…" });
      const text = await analyzeText(deck);
      setFindings((f) => [...f, ...text]);
      setProgress({ done: 1, total, label: `Reading ${imageJobs.length} images…` });

      const images = await analyzeImages(imageJobs, (done, n) =>
        setProgress({ done: done + 1, total, label: `Reading images ${done}/${n}…` }),
      );
      setFindings((f) => [...f, ...images]);
      setAiDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "AI check failed.");
    } finally {
      setPhase("ready");
      setProgress({ done: 0, total: 0, label: "" });
    }
  }, [deck, imageJobs]);

  const matches = useCallback(
    (f: Finding) => {
      if (!query.trim()) return true;
      const q = query.toLowerCase();
      return (
        f.title.toLowerCase().includes(q) ||
        f.detail.toLowerCase().includes(q) ||
        (f.quote?.toLowerCase().includes(q) ?? false)
      );
    },
    [query],
  );

  const filtered = useMemo(() => findings.filter(matches), [findings, matches]);
  const groups = useMemo(() => groupFindings(filtered), [filtered]);
  const perSlide = useMemo(() => countBySlide(findings), [findings]);

  const slideFindings = useMemo(
    () =>
      filtered
        .filter((f) => f.slide === slide || f.relatedSlides?.includes(slide))
        .sort(bySeverity),
    [filtered, slide],
  );

  const openFinding = useCallback((f: Finding) => {
    setSlide(f.slide);
    setActive(f.id);
    setView("slides");
  }, []);

  // ←/→ to walk slides while in the slide view.
  useEffect(() => {
    if (view !== "slides" || !deck) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "ArrowLeft") setSlide((n) => Math.max(1, n - 1));
      if (e.key === "ArrowRight") setSlide((n) => Math.min(deck.slides.length, n + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, deck]);

  const current = deck?.slides.find((s) => s.index === slide);
  const highlight = new Set(findings.find((f) => f.id === active)?.shapeIds ?? []);

  // w-full: `mx-auto` on a column flex child would otherwise shrink main to content width.
  return (
    <main className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-5 p-4 md:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight">Proposal Checker</h1>
          <p className="truncate text-xs text-neutral-500">
            {deck ? `${fileName} · ${deck.slides.length} slides` : "Typos, blurry images, and inconsistent sizing"}
          </p>
        </div>

        {deck && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-md border border-neutral-300 p-0.5 dark:border-neutral-700">
              {(["summary", "slides"] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`rounded px-3 py-1 text-xs font-medium capitalize transition ${
                    view === v
                      ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
                      : "text-neutral-500 hover:text-neutral-900 dark:hover:text-white"
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>

            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search findings…"
              className="w-44 rounded-md border border-neutral-300 bg-transparent px-2.5 py-1.5 text-xs outline-none placeholder:text-neutral-400 focus:border-neutral-900 dark:border-neutral-700 dark:focus:border-white"
            />

            <button
              onClick={() =>
                download(`${fileName}.check.md`, toMarkdown(fileName, deck.slides.length, findings), "text/markdown")
              }
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              Export report
            </button>

            <AiButton
              phase={phase}
              hasKey={hasKey}
              aiDone={aiDone}
              images={imageJobs.length}
              label={progress.label}
              onClick={runAi}
            />
          </div>
        )}
      </header>

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

      {!deck && <Dropzone busy={phase === "parsing"} onFile={load} />}

      {deck && view === "summary" && (
        <Summary all={findings} groups={groups} slideCount={deck.slides.length} query={query} onOpen={openFinding} />
      )}

      {deck && view === "slides" && current && (
        <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-[9.5rem_1fr_24rem]">
          <SlideRail deck={deck} urls={urls} counts={perSlide} current={slide} onPick={setSlide} />

          <section className="min-w-0">
            <div className="overflow-hidden rounded-lg border border-neutral-300 shadow-sm dark:border-neutral-700">
              <SlidePreview deck={deck} slide={current} urls={urls} highlight={highlight} />
            </div>
            <p className="mt-2 text-xs text-neutral-500">
              Slide {slide} of {deck.slides.length} · use ← → to move · approximate reconstruction, click a finding to
              highlight its shape
            </p>
          </section>

          <aside className="flex max-h-[calc(100vh-11rem)] flex-col overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
            <div className="border-b border-neutral-200 px-3.5 py-2.5 text-xs font-medium dark:border-neutral-800">
              {slideFindings.length} finding{slideFindings.length === 1 ? "" : "s"} on this slide
            </div>
            <div className="flex-1 divide-y divide-neutral-100 overflow-y-auto dark:divide-neutral-900">
              {slideFindings.length === 0 && (
                <p className="p-8 text-center text-sm text-neutral-500">This slide is clean.</p>
              )}
              {slideFindings.map((f) => (
                <FindingCard
                  key={f.id}
                  f={f}
                  active={f.id === active}
                  showSlide={false}
                  onClick={() => setActive(f.id === active ? null : f.id)}
                />
              ))}
            </div>
          </aside>
        </div>
      )}
    </main>
  );
}

function AiButton({
  phase,
  hasKey,
  aiDone,
  images,
  label,
  onClick,
}: {
  phase: Phase;
  hasKey: boolean | null;
  aiDone: boolean;
  images: number;
  label: string;
  onClick: () => void;
}) {
  if (hasKey === false) {
    return (
      <span
        title="Add ANTHROPIC_API_KEY to .env.local and restart the server"
        className="cursor-not-allowed rounded-md border border-dashed border-neutral-300 px-3 py-1.5 text-xs text-neutral-400 dark:border-neutral-700"
      >
        AI check needs an API key
      </span>
    );
  }

  return (
    <button
      onClick={onClick}
      disabled={phase === "ai" || hasKey === null}
      className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
    >
      {phase === "ai" ? label || "Running…" : aiDone ? `Re-run AI check (${images} images)` : `Deep check with AI (${images} images)`}
    </button>
  );
}
