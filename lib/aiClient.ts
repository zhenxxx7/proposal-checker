"use client";

import type { AiFinding } from "./aiSchema";
import { px96, type Deck, type Finding, type PicShape } from "./types";

/** Opus 4.8 accepts up to 2576px on the long edge. Stay under it. */
const MAX_EDGE = 2200;
const JPEG_QUALITY = 0.9;

let seq = 0;
const toFinding = (f: AiFinding, source: "ai-text" | "ai-image", shapeIds?: string[]): Finding => ({
  id: `a${++seq}`,
  slide: f.slide,
  severity: f.severity,
  category: f.category,
  source,
  title: f.detail.split(/[.\n]/)[0].slice(0, 90) || "Issue found",
  detail: f.detail,
  quote: f.quote,
  suggestion: f.suggestion,
  shapeIds,
});

export function slideTexts(deck: Deck) {
  return deck.slides
    .map((s) => ({
      n: s.index,
      texts: s.shapes.flatMap((sh) => (sh.kind === "text" ? sh.paragraphs.map((p) => p.text) : [])),
    }))
    .filter((s) => s.texts.length > 0);
}

export async function analyzeText(deck: Deck): Promise<Finding[]> {
  const slides = slideTexts(deck);
  if (!slides.length) return [];
  const res = await fetch("/api/analyze-text", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slides }),
  });
  const json = (await res.json()) as { findings?: AiFinding[]; error?: string };
  if (json.error) throw new Error(json.error);
  return (json.findings ?? []).map((f) => toFinding(f, "ai-text"));
}

export interface ImageJob {
  slide: number;
  pic: PicShape;
  blob: Blob;
  slideText: string;
}

/** Images worth spending vision tokens on: big enough on-slide to carry readable copy. */
export function selectImageJobs(deck: Deck, minAreaPct = 2): ImageJob[] {
  const jobs: ImageJob[] = [];
  const slideArea = deck.widthEmu * deck.heightEmu;
  for (const slide of deck.slides) {
    const slideText = slide.shapes
      .flatMap((sh) => (sh.kind === "text" ? sh.paragraphs.map((p) => p.text) : []))
      .join("\n");
    for (const sh of slide.shapes) {
      if (sh.kind !== "pic") continue;
      const info = deck.media.get(sh.media);
      const blob = deck.blobs.get(sh.media);
      if (!info || !blob || info.format === "svg" || info.format === "unknown") continue;
      if (info.width < 300) continue;
      if ((sh.rect.w * sh.rect.h) / slideArea < minAreaPct / 100) continue;
      jobs.push({ slide: slide.index, pic: sh, blob, slideText });
    }
  }
  return jobs;
}

export async function analyzeImages(
  jobs: ImageJob[],
  onProgress: (done: number, total: number) => void,
  concurrency = 3,
  signal?: AbortSignal,
): Promise<Finding[]> {
  const out: Finding[] = [];
  let done = 0;
  let cursor = 0;

  const worker = async () => {
    while (cursor < jobs.length) {
      if (signal?.aborted) return;
      const job = jobs[cursor++];
      try {
        const { base64, mediaType } = await downscale(job.blob);
        const res = await fetch("/api/analyze-image", {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal,
          body: JSON.stringify({
            slide: job.slide,
            image: base64,
            mediaType,
            slideText: job.slideText.slice(0, 4000),
            displayPx: { w: Math.round(px96(job.pic.rect.w)), h: Math.round(px96(job.pic.rect.h)) },
          }),
        });
        const json = (await res.json()) as { findings?: AiFinding[] };
        for (const f of json.findings ?? []) out.push(toFinding(f, "ai-image", [job.pic.id]));
      } catch {
        // One bad image must not abort the run.
      }
      onProgress(++done, jobs.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return out;
}

/** Re-encode to JPEG under the vision size cap. Returns bare base64 (no data: prefix). */
async function downscale(blob: Blob): Promise<{ base64: string; mediaType: "image/jpeg" }> {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  // Flatten transparency onto white — a transparent PNG reads as black otherwise.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
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
