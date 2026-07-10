"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Dropzone, type GoogleSlidesStream } from "@/components/Dropzone";
import { FindingCard } from "@/components/FindingCard";
import { SlidePreview } from "@/components/SlidePreview";
import { SlideRail, countBySlide } from "@/components/SlideRail";
import { Summary } from "@/components/Summary";
import { Button, Card, SearchInput, Tabs, ThemeToggle } from "@/components/ui";
import { analyzeImages, analyzeText, selectImageJobs } from "@/lib/aiClient";
import { collectFamilies, googleFontsUrl } from "@/lib/fonts";
import { runRuleChecks } from "@/lib/checks";
import { groupFindings } from "@/lib/groups";
import { parsePptx, parsePptxStream } from "@/lib/pptx";
import { bySeverity, download, toMarkdown } from "@/lib/report";
import type { Deck, Finding } from "@/lib/types";

type Phase = "idle" | "parsing" | "ready" | "ai";
const VIEWS = ["summary", "slides"] as const;
type View = (typeof VIEWS)[number];

interface Status {
  configured: boolean;
  label: string;
  model: string;
}

const NO_AI: Status = { configured: false, label: "", model: "" };

async function fetchAiStatus(): Promise<Status> {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) return NO_AI;
    return await response.json() as Status;
  } catch {
    return NO_AI;
  }
}

export default function Page() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [view, setView] = useState<View>("summary");
  const [fileName, setFileName] = useState("");
  const [deck, setDeck] = useState<Deck | null>(null);
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  const [findings, setFindings] = useState<Finding[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0, label: "" });
  const [status, setStatus] = useState<Status | null>(null);
  const [aiDone, setAiDone] = useState(false);
  const [abort, setAbort] = useState<AbortController | null>(null);

  const [slide, setSlide] = useState(1);
  const [active, setActive] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // Revokes the *previous* map when `urls` is replaced, and everything on unmount.
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);

  // Load the deck's webfonts (Google-exported decks use Google Fonts) so the
  // preview renders in the real faces. Unknown fonts fall back silently.
  useEffect(() => {
    if (!deck) return;
    const names = new Set<string>();
    for (const s of deck.slides)
      for (const sh of [...(s.backgroundShapes ?? []), ...s.shapes])
        if (sh.kind === "text")
          for (const p of sh.paragraphs) for (const r of p.runs) if (r.font) names.add(r.font);
    const url = googleFontsUrl(collectFamilies(names));
    if (!url || document.querySelector(`link[href="${url}"]`)) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = url;
    document.head.appendChild(link);
  }, [deck]);

  useEffect(() => {
    void fetchAiStatus().then(setStatus);
  }, []);

  const runCombined = useCallback(async (
    targetDeck: Deck,
    jobs: ReturnType<typeof selectImageJobs>,
    includeRules: boolean,
  ) => {
    const controller = new AbortController();
    setAbort(controller);
    setPhase("ai");
    setError(null);
    setAiDone(false);

    const total = jobs.length + 1 + (includeRules ? 1 : 0);
    let localDone = 0;
    let textDone = 0;
    let imagesDone = 0;
    const report = (label: string) =>
      setProgress({ done: localDone + textDone + imagesDone, total, label });

    report(includeRules ? "Running local and AI checks..." : "Re-running AI checks...");

    try {
      // Start remote text and vision work first. Local rules run while those
      // requests are already in flight.
      const textPromise = analyzeText(targetDeck, controller.signal).then((result) => {
        textDone = 1;
        report("Analyzing deck...");
        return result;
      });
      const imagesPromise = analyzeImages(
        jobs,
        (done) => {
          imagesDone = done;
          report("Analyzing deck...");
        },
        2,
        controller.signal,
      );

      if (includeRules) {
        setFindings(runRuleChecks(targetDeck));
        localDone = 1;
      } else {
        setFindings((current) => current.filter((finding) => finding.source === "rule"));
      }
      report("Analyzing deck...");

      const [textResult, imageResult] = await Promise.allSettled([textPromise, imagesPromise]);
      const combined = [
        ...(textResult.status === "fulfilled" ? textResult.value : []),
        ...(imageResult.status === "fulfilled" ? imageResult.value : []),
      ];
      setFindings((current) => [...current.filter((finding) => finding.source === "rule"), ...combined]);

      const failure = textResult.status === "rejected"
        ? textResult.reason
        : imageResult.status === "rejected"
          ? imageResult.reason
          : null;
      if (failure && !controller.signal.aborted) {
        setError(failure instanceof Error ? failure.message : "AI check partly failed.");
      }
      if (!controller.signal.aborted) setAiDone(true);
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "AI check failed.");
    } finally {
      setAbort(null);
      setPhase("ready");
      setProgress({ done: 0, total: 0, label: "" });
    }
  }, []);

  const loadDeck = useCallback(async (name: string, readDeck: () => Promise<Deck>) => {
    setPhase("parsing");
    setError(null);
    setFindings([]);
    setDeck(null);
    setUrls(new Map());
    setAiDone(false);
    setActive(null);
    setQuery("");
    setFileName(name);
    // Let the parsing frame paint before unzip blocks the main thread.
    await new Promise((resolve) => setTimeout(resolve, 30));

    try {
      // Refresh this for every deck. A transient startup failure on a phone
      // must not leave automatic AI analysis disabled for the whole session.
      const [parsed, providerStatus] = await Promise.all([readDeck(), fetchAiStatus()]);
      setStatus(providerStatus);

      const next = new Map<string, string>();
      for (const [path, blob] of parsed.blobs) next.set(path, URL.createObjectURL(blob));
      setUrls(next);
      setDeck(parsed);
      setSlide(1);
      setView("summary");

      if (providerStatus.configured) {
        await runCombined(parsed, selectImageJobs(parsed), true);
      } else {
        setFindings(runRuleChecks(parsed));
        setPhase("ready");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that file.");
      setPhase("idle");
    }
  }, [runCombined]);

  const load = useCallback(
    (file: File) => loadDeck(file.name, async () => parsePptx(await file.arrayBuffer())),
    [loadDeck],
  );
  const loadGoogleSlides = useCallback(
    (source: GoogleSlidesStream) =>
      loadDeck(source.name, () => parsePptxStream(source.stream, source.reportProgress)),
    [loadDeck],
  );

  const imageJobs = useMemo(() => (deck ? selectImageJobs(deck) : []), [deck]);
  const rerunAi = useCallback(() => {
    if (deck) void runCombined(deck, imageJobs, false);
  }, [deck, imageJobs, runCombined]);

  const matches = useCallback(
    (f: Finding) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
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
    () => filtered.filter((f) => f.slide === slide || f.relatedSlides?.includes(slide)).sort(bySeverity),
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

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-zinc-200 bg-white/95 backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-950/95">
        <div className="mx-auto flex h-16 w-full max-w-[1920px] items-center gap-3 px-4 lg:px-5">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-zinc-900 text-white dark:bg-white dark:text-zinc-900">
              <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="m3 10.5 4 4 10-10" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <div className="min-w-0">
              <p className="text-[13px] font-semibold leading-tight">Proposal Checker</p>
              {deck && (
                <p className="truncate text-[11px] leading-tight text-zinc-500 dark:text-zinc-400">
                  {fileName} · {deck.slides.length} slides
                </p>
              )}
            </div>
          </div>

          <div className="ml-auto flex items-center gap-2">
            {deck && (
              <>
                <div className="hidden sm:block">
                  <Tabs value={view} options={VIEWS} onChange={setView} />
                </div>
                <div className="hidden md:block">
                  <SearchInput value={query} onChange={setQuery} />
                </div>
                <Button
                  className={phase === "ai" ? "hidden sm:inline-flex" : ""}
                  onClick={() =>
                    download(`${fileName}.check.md`, toMarkdown(fileName, deck.slides.length, findings), "text/markdown")
                  }
                >
                  Export
                </Button>
                {phase === "ai" && abort && (
                  <Button onClick={() => abort.abort()} title="Stop and keep what was found so far">
                    Cancel
                  </Button>
                )}
                <AiButton
                  phase={phase}
                  status={status}
                  aiDone={aiDone}
                  images={imageJobs.length}
                  label={progress.label}
                  onClick={rerunAi}
                />
              </>
            )}
            <ThemeToggle />
          </div>
        </div>

        {phase === "ai" && progress.total > 0 && (
          <div className="h-0.5 w-full bg-zinc-200 dark:bg-zinc-800">
            <div
              className="h-full bg-indigo-600 transition-all duration-300 dark:bg-indigo-400"
              style={{ width: `${(progress.done / progress.total) * 100}%` }}
            />
          </div>
        )}
      </header>

      <main className="mx-auto flex w-full max-w-[1920px] flex-1 flex-col gap-4 p-4 lg:p-5">
        {error && (
          <Card className="border-rose-300 bg-rose-50 px-4 py-2.5 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200">
            {error}
          </Card>
        )}

        {deck && phase === "ai" && (
          <div
            role="status"
            aria-live="polite"
            className="flex min-h-10 items-center gap-3 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-950 dark:border-indigo-900 dark:bg-indigo-950/40 dark:text-indigo-100"
          >
            <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600 dark:border-indigo-800 dark:border-t-indigo-300" />
            <span className="min-w-0 flex-1 truncate">{progress.label || "Analyzing presentation..."}</span>
            {progress.total > 0 && (
              <span className="shrink-0 text-xs tabular-nums text-indigo-700 dark:text-indigo-300">
                {progress.done}/{progress.total}
              </span>
            )}
          </div>
        )}

        {!deck && (
          <Dropzone busy={phase === "parsing"} onFile={load} onGoogleSlides={loadGoogleSlides} />
        )}

        {deck && view === "summary" && (
          <Summary all={findings} groups={groups} slideCount={deck.slides.length} query={query} onOpen={openFinding} />
        )}

        {deck && view === "slides" && current && (
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-[11.5rem_minmax(0,1fr)_22rem]">
            <aside className="flex min-h-0 max-h-[calc(100vh-10.5rem)] flex-col overflow-hidden rounded-lg border border-zinc-200 bg-zinc-100/80 p-2 dark:border-zinc-800 dark:bg-zinc-900/50">
              <div className="flex shrink-0 items-center justify-between px-1.5 pb-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Slides</p>
                <span className="text-[11px] tabular-nums text-zinc-400">{deck.slides.length}</span>
              </div>
              <SlideRail deck={deck} urls={urls} counts={perSlide} current={slide} onPick={setSlide} />
            </aside>

            <section data-stage className="flex min-h-[32rem] min-w-0 flex-col rounded-lg border border-zinc-200 bg-zinc-100 p-2 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
              <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-md">
                <div className="w-full overflow-hidden rounded-md bg-white shadow-[0_10px_28px_rgba(0,0,0,0.16)]" style={{ maxWidth: "min(100%, calc((100vh - 12.5rem) * 1.778))" }}>
                  <SlidePreview deck={deck} slide={current} urls={urls} highlight={highlight} />
                </div>
              </div>
              <p data-slide-caption className="px-1 pt-2.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                Slide {slide} of {deck.slides.length} · <kbd className="font-mono">←</kbd>{" "}
                <kbd className="font-mono">→</kbd> to move · click a finding to highlight its shape
              </p>
            </section>

            <aside className="flex max-h-[calc(100vh-10.5rem)] flex-col overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
              <div className="border-b border-zinc-100 px-4 py-3 text-[13px] font-medium dark:border-zinc-800">
                {slideFindings.length} finding{slideFindings.length === 1 ? "" : "s"} on this slide
              </div>
              <div className="flex-1 divide-y divide-zinc-100 overflow-y-auto dark:divide-zinc-800">
                {slideFindings.length === 0 && (
                  <div className="grid flex-1 place-items-center p-10 text-center">
                    <p className="text-sm text-zinc-400">This slide is clean.</p>
                  </div>
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
    </>
  );
}

function AiButton({
  phase,
  status,
  aiDone,
  images,
  label,
  onClick,
}: {
  phase: Phase;
  status: Status | null;
  aiDone: boolean;
  images: number;
  label: string;
  onClick: () => void;
}) {
  if (status && !status.configured) {
    return (
      <span
        title="Set AI_PROVIDER and AI_API_KEY in .env.local, then restart the server"
        className="cursor-not-allowed rounded-lg border border-dashed border-zinc-300 px-3 py-1.5 text-[13px] text-zinc-400 dark:border-zinc-700"
      >
        AI check needs a key
      </span>
    );
  }

  const running = phase === "ai";
  const hint = status
    ? `${status.label} · ${status.model} · ${images + 1} requests. Free tiers rate-limit; the run backs off and can be cancelled.`
    : "";
  return (
    <Button variant="primary" onClick={onClick} disabled={running || !status} title={hint}>
      {running && <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
      <span className="sm:hidden">{running ? "Analyzing" : aiDone ? "AI again" : "AI check"}</span>
      <span className="hidden sm:inline">
        {running ? label || "Running..." : aiDone ? "Re-run AI check" : `Deep check with AI (${images})`}
      </span>
    </Button>
  );
}
