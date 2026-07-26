"use client";

import type { AiFinding } from "./ai/schema";
import { normQuote } from "./textNorm";
import { px96, type Deck, type Finding, type PicShape } from "./types";
import { isVisibleOnSlide } from "./visibility";

/** Free-tier vision models bill and choke on big images. 1400px reads UI text fine. */
const MAX_EDGE = 1400;
const JPEG_QUALITY = 0.85;

let seq = 0;
const toFinding = (f: AiFinding, source: "ai-text" | "ai-image", shapeIds?: string[]): Finding => ({
  id: `a${++seq}`,
  code: source === "ai-image" ? "ai.image" : "ai.text",
  slide: f.slide,
  severity: f.severity,
  category: f.category,
  source,
  title: f.quote ? `“${f.quote.slice(0, 60)}”` : f.detail.split(/[.\n]/)[0].slice(0, 90) || "Issue found",
  detail: f.detail,
  quote: f.quote,
  suggestion: f.suggestion,
  shapeIds,
});

export function slideTexts(deck: Deck) {
  return deck.slides
    .map((s) => ({
      n: s.index,
      texts: s.shapes.flatMap((sh) =>
        sh.kind === "text" && isVisibleOnSlide(sh, deck.widthEmu, deck.heightEmu)
          ? sh.paragraphs.map((p) => p.text)
          : [],
      ),
    }))
    .filter((s) => s.texts.length > 0);
}

/** Which model/prompt actually produced a run's findings — feedback provenance. */
export interface AnalysisProvenance {
  provider?: string;
  model?: string;
  promptVersion?: string;
  analysisInputId?: string;
}

interface AnalyzeResponse {
  findings?: AiFinding[];
  error?: string;
  model?: { provider?: string; name?: string };
  promptVersion?: string;
  analysisInput?: { id?: string } | null;
}

function toProvenance(json: AnalyzeResponse): AnalysisProvenance {
  return {
    provider: json.model?.provider,
    model: json.model?.name,
    promptVersion: json.promptVersion,
    analysisInputId: json.analysisInput?.id,
  };
}

export interface TextAnalysis {
  findings: Finding[];
  provenance: AnalysisProvenance | null;
}

export async function analyzeText(
  deck: Deck,
  deckFingerprint?: string,
  signal?: AbortSignal,
): Promise<TextAnalysis> {
  const slides = slideTexts(deck);
  if (!slides.length) return { findings: [], provenance: null };
  const res = await fetch("/api/analyze-text", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify({ slides, ...(deckFingerprint ? { deckFingerprint } : {}) }),
  });
  const json = (await res.json()) as AnalyzeResponse;
  if (json.error) throw new Error(json.error);

  // Ground every finding in the real slide text: the model is told to quote
  // verbatim, so a quote that is not actually on its slide is a hallucination.
  // Drop it. Quote-less findings (deck-wide consistency) are kept as-is.
  const textByN = new Map(slides.map((s) => [s.n, normQuote(s.texts.join("\n"))]));
  const findings = (json.findings ?? [])
    .filter((f) => {
      if (!f.quote?.trim()) return true;
      return (textByN.get(f.slide) ?? "").includes(normQuote(f.quote));
    })
    .map((f) => toFinding(f, "ai-text"));
  return { findings, provenance: toProvenance(json) };
}

export interface ImageJob {
  /** representative slide, used for prompt context */
  slide: number;
  pic: PicShape;
  blob: Blob;
  /** every place this exact image (same file, same crop) is used */
  uses: { slide: number; shapeId: string }[];
}

/**
 * Images worth spending vision tokens on: big enough on-slide to carry readable
 * copy. Deduplicated by file + crop — a logo reused on 30 slides is one request,
 * and any typo found in it is reported on all 30. Free tiers rate-limit hard.
 */
export function selectImageJobs(deck: Deck, minAreaPct = 2): ImageJob[] {
  const slideArea = deck.widthEmu * deck.heightEmu;
  const byKey = new Map<string, ImageJob>();

  for (const slide of deck.slides) {
    for (const sh of slide.shapes) {
      if (sh.kind !== "pic") continue;
      if (!isVisibleOnSlide(sh, deck.widthEmu, deck.heightEmu)) continue;
      const info = deck.media.get(sh.media);
      const blob = deck.blobs.get(sh.media);
      if (!info || !blob || info.format === "svg" || info.format === "unknown") continue;
      if (info.width < 300) continue;
      if ((sh.rect.w * sh.rect.h) / slideArea < minAreaPct / 100) continue;

      const crop = [sh.crop.l, sh.crop.t, sh.crop.r, sh.crop.b].map((v) => v.toFixed(3)).join(",");
      const key = `${sh.media}|${crop}`;
      const existing = byKey.get(key);
      if (existing) existing.uses.push({ slide: slide.index, shapeId: sh.id });
      else byKey.set(key, { slide: slide.index, pic: sh, blob, uses: [{ slide: slide.index, shapeId: sh.id }] });
    }
  }
  return [...byKey.values()];
}

export interface ImageAnalysis {
  findings: Finding[];
  provenance: AnalysisProvenance | null;
}

export async function analyzeImages(
  jobs: ImageJob[],
  onProgress: (done: number, total: number) => void,
  // Free tiers cap requests per minute. Two in flight keeps the retry budget intact.
  concurrency = 2,
  signal?: AbortSignal,
  deckFingerprint?: string,
): Promise<ImageAnalysis> {
  const out: Finding[] = [];
  let provenance: AnalysisProvenance | null = null;
  let done = 0;
  let cursor = 0;

  const worker = async () => {
    while (cursor < jobs.length) {
      if (signal?.aborted) return;
      const job = jobs[cursor++];
      try {
        const { base64, mediaType } = await downscale(job.blob, job.pic.crop);
        const res = await fetch("/api/analyze-image", {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal,
          body: JSON.stringify({
            slide: job.slide,
            image: base64,
            mediaType,
            displayPx: { w: Math.round(px96(job.pic.rect.w)), h: Math.round(px96(job.pic.rect.h)) },
            ...(deckFingerprint ? { deckFingerprint } : {}),
          }),
        });
        const json = (await res.json()) as AnalyzeResponse;
        // All image calls serve from one model per run; keep the last seen.
        provenance = toProvenance(json);
        // A typo inside a reused image exists on every slide that shows it.
        for (const f of json.findings ?? [])
          for (const use of job.uses) out.push(toFinding({ ...f, slide: use.slide }, "ai-image", [use.shapeId]));
      } catch {
        // One bad image must not abort the run.
      }
      onProgress(++done, jobs.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return { findings: out, provenance };
}

export function imageCropRect(width: number, height: number, crop: PicShape["crop"]) {
  const left = Math.min(0.999, Math.max(0, crop.l));
  const top = Math.min(0.999, Math.max(0, crop.t));
  const right = Math.min(0.999 - left, Math.max(0, crop.r));
  const bottom = Math.min(0.999 - top, Math.max(0, crop.b));
  return {
    x: width * left,
    y: height * top,
    w: Math.max(1, width * (1 - left - right)),
    h: Math.max(1, height * (1 - top - bottom)),
  };
}

/**
 * Crop exactly what PowerPoint displays, then re-encode under the vision cap.
 * Hidden text outside srcRect must not become an AI finding.
 */
async function downscale(blob: Blob, crop: PicShape["crop"]): Promise<{ base64: string; mediaType: "image/jpeg" }> {
  const bmp = await createImageBitmap(blob);
  const source = imageCropRect(bmp.width, bmp.height, crop);
  const scale = Math.min(1, MAX_EDGE / Math.max(source.w, source.h));
  const w = Math.max(1, Math.round(source.w * scale));
  const h = Math.max(1, Math.round(source.h * scale));

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  // Flatten transparency onto white — a transparent PNG reads as black otherwise.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, source.x, source.y, source.w, source.h, 0, 0, w, h);
  bmp.close();

  const jpeg = await canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
  return { base64: await blobToBase64(jpeg), mediaType: "image/jpeg" };
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(blob);
  });
}
