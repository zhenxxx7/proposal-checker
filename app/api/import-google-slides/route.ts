import { DOMParser as XmldomParser } from "@xmldom/xmldom";
import sharp from "sharp";
import { DECK_WIRE_HEADER, DECK_WIRE_TYPE, DeckWireWriter } from "@/lib/deckWire";
import { parsePptxStream, type XmlParser } from "@/lib/pptx";
import type { Deck, MediaInfo } from "@/lib/types";

const PPTX_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const MAX_BYTES = 250 * 1024 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024;
const UPSTREAM_TIMEOUT_MS = 120_000;
const OPTIMIZE_MIN_BYTES = 256 * 1024;
const OPTIMIZE_MAX_EDGE = 1800;
const OPTIMIZE_CONCURRENCY = 4;

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const requestId = crypto.randomUUID().slice(0, 8);
  console.info(`[google-slides:${requestId}] import requested`);

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return Response.json({ error: "Request body must be JSON." }, { status: 415 });
  }
  const announcedRequestBytes = Number(request.headers.get("content-length"));
  if (Number.isFinite(announcedRequestBytes) && announcedRequestBytes > MAX_REQUEST_BYTES) {
    return Response.json({ error: "Request body is too large." }, { status: 413 });
  }

  let input: unknown;
  try {
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
      return Response.json({ error: "Request body is too large." }, { status: 413 });
    }
    input = JSON.parse(body);
  } catch {
    console.warn(`[google-slides:${requestId}] invalid JSON body`);
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const link = typeof input === "object" && input !== null && "url" in input
    ? String((input as { url: unknown }).url).trim()
    : "";
  const presentationId = googleSlidesId(link);
  if (!presentationId) {
    console.warn(`[google-slides:${requestId}] unsupported link format`);
    return Response.json(
      {
        error: isPublishedLink(link)
          ? "Use the Google Slides Share link, not the Publish to web link."
          : "Paste a Google Slides or Google Drive share link.",
      },
      { status: 400 },
    );
  }

  const exportUrl = `https://docs.google.com/presentation/d/${presentationId}/export/pptx`;

  try {
    const upstream = await fetch(exportUrl, {
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]),
      headers: {
        accept: `${PPTX_TYPE}, application/octet-stream;q=0.9, */*;q=0.1`,
        "accept-encoding": "identity",
        "user-agent": "Mozilla/5.0 ProposalChecker/1.0",
      },
    });

    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel();
      console.warn(`[google-slides:${requestId}] Google export failed`, { status: upstream.status });
      return googleAccessError(upstream.status);
    }

    const contentLength = upstream.headers.get("content-length");
    const contentEncoding = upstream.headers.get("content-encoding");
    const announcedBytes = contentLength === null || (contentEncoding && contentEncoding !== "identity")
      ? null
      : Number(contentLength);
    if (announcedBytes !== null && Number.isFinite(announcedBytes) && announcedBytes > MAX_BYTES) {
      await upstream.body.cancel();
      return Response.json({ error: "This presentation is larger than 250MB." }, { status: 413 });
    }

    const reader = upstream.body.getReader();
    const initial: Uint8Array[] = [];
    let initialBytes = 0;
    while (initialBytes < 4) {
      const chunk = await reader.read();
      if (chunk.done) break;
      initial.push(chunk.value);
      initialBytes += chunk.value.byteLength;
      if (initialBytes > MAX_BYTES) {
        await reader.cancel("Presentation exceeds 250MB");
        return Response.json({ error: "This presentation is larger than 250MB." }, { status: 413 });
      }
    }
    const signature = new Uint8Array(Math.min(4, initialBytes));
    let signatureOffset = 0;
    for (const chunk of initial) {
      const take = Math.min(chunk.byteLength, signature.byteLength - signatureOffset);
      signature.set(chunk.subarray(0, take), signatureOffset);
      signatureOffset += take;
      if (signatureOffset === signature.byteLength) break;
    }
    if (
      signature.length < 4 ||
      signature[0] !== 0x50 ||
      signature[1] !== 0x4b ||
      signature[2] !== 0x03 ||
      signature[3] !== 0x04
    ) {
      await reader.cancel();
      console.warn(`[google-slides:${requestId}] Google returned a non-PPTX response`);
      return googleAccessError(upstream.status);
    }

    let transferred = initialBytes;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of initial) controller.enqueue(chunk);
      },
      async pull(controller) {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          return;
        }
        transferred += chunk.value.byteLength;
        if (transferred > MAX_BYTES) {
          await reader.cancel("Presentation exceeds 250MB");
          controller.error(new Error("Presentation exceeds 250MB"));
          return;
        }
        controller.enqueue(chunk.value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });

    const fileName = exportedFileName(upstream.headers.get("content-disposition"));
    const totalBytes = announcedBytes !== null && Number.isFinite(announcedBytes) ? announcedBytes : null;
    const output = new TransformStream<Uint8Array, Uint8Array>();
    const wire = new DeckWireWriter(output.writable.getWriter());
    void (async () => {
      try {
        await wire.progress({ phase: "download", loaded: 0, total: totalBytes });
        let lastBytes = -1;
        let lastPercent = -1;
        const reportDownload = async (loaded: number) => {
          const percent = totalBytes && totalBytes > 0
            ? Math.min(100, Math.floor((loaded / totalBytes) * 100))
            : -1;
          if (percent === lastPercent && loaded - lastBytes < 512 * 1024) return;
          lastBytes = loaded;
          lastPercent = percent;
          await wire.progress({ phase: "download", loaded, total: totalBytes });
        };

        const parser = new XmldomParser() as unknown as XmlParser;
        const parsed = await parsePptxStream(stream, reportDownload, parser);
        await wire.progress({ phase: "download", loaded: transferred, total: totalBytes ?? transferred });
        await wire.progress({ phase: "prepare", loaded: 0, total: null });
        const deck = await prepareDeckForTransfer(parsed);
        const assetBytes = [...deck.blobs.values()].reduce((total, blob) => total + blob.size, 0);
        console.info(`[google-slides:${requestId}] server import prepared`, {
          sourceBytes: transferred,
          assetBytes,
          slides: deck.slides.length,
          assets: deck.blobs.size,
        });
        await wire.deck(fileName, deck, transferred);
        await wire.close();
      } catch (error) {
        void reader.cancel(error).catch(() => undefined);
        const message = error instanceof Error && error.message === "Presentation exceeds 250MB"
          ? "This presentation is larger than 250MB."
          : "Google Slides could not be prepared. Try again.";
        console.error(`[google-slides:${requestId}] import processing failed`, error);
        try {
          await wire.error(message);
          await wire.close();
        } catch {
          await wire.abort(error).catch(() => undefined);
          // Client disconnected while serverless processing was active.
        }
      }
    })();

    return new Response(output.readable, {
      headers: {
        "cache-control": "private, no-store",
        "content-type": DECK_WIRE_TYPE,
        "cross-origin-resource-policy": "same-origin",
        "x-accel-buffering": "no",
        "x-content-type-options": "nosniff",
        "x-deck-transfer": DECK_WIRE_HEADER,
        "x-download-handler": "server",
        "x-file-name": encodeURIComponent(fileName),
        ...(totalBytes !== null ? { "x-source-bytes": String(totalBytes) } : {}),
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Presentation exceeds 250MB") {
      return Response.json({ error: "This presentation is larger than 250MB." }, { status: 413 });
    }
    console.error(`[google-slides:${requestId}] import failed`, error);
    return Response.json(
      { error: "Google Slides could not be reached. Try again." },
      { status: 502 },
    );
  }
}

async function prepareDeckForTransfer(deck: Deck): Promise<Deck> {
  const referenced = new Set<string>();
  for (const slide of deck.slides) {
    if (slide.background?.type === "image") referenced.add(slide.background.media);
    for (const shape of [...(slide.backgroundShapes ?? []), ...slide.shapes]) {
      if (shape.kind === "pic") referenced.add(shape.media);
      if (shape.kind === "text" && shape.fill?.type === "image") referenced.add(shape.fill.media);
    }
  }

  const paths = [...referenced];
  const results = new Array<{ path: string; info: MediaInfo; blob: Blob } | null>(paths.length).fill(null);
  let cursor = 0;
  const worker = async () => {
    while (cursor < paths.length) {
      const index = cursor++;
      const path = paths[index];
      const info = deck.media.get(path);
      const blob = deck.blobs.get(path);
      if (!info || !blob) continue;
      results[index] = { path, info, blob: await optimizePreview(blob, info) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(OPTIMIZE_CONCURRENCY, paths.length) }, worker));

  const media = new Map<string, MediaInfo>();
  const blobs = new Map<string, Blob>();
  for (const result of results) {
    if (!result) continue;
    media.set(result.path, result.info);
    blobs.set(result.path, result.blob);
  }
  return { ...deck, media, blobs };
}

async function optimizePreview(blob: Blob, info: MediaInfo): Promise<Blob> {
  if (
    blob.size < OPTIMIZE_MIN_BYTES ||
    info.width <= 0 ||
    info.height <= 0 ||
    !(["png", "jpg", "webp"] as const).includes(info.format as "png" | "jpg" | "webp")
  ) {
    return blob;
  }

  try {
    const input = Buffer.from(await blob.arrayBuffer());
    const optimized = await sharp(input, { limitInputPixels: 100_000_000 })
      .rotate()
      .resize({
        width: OPTIMIZE_MAX_EDGE,
        height: OPTIMIZE_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 90, effort: 4 })
      .toBuffer();
    if (optimized.byteLength >= input.byteLength) return blob;
    const bytes = optimized.buffer.slice(optimized.byteOffset, optimized.byteOffset + optimized.byteLength) as ArrayBuffer;
    return new Blob([bytes], { type: "image/webp" });
  } catch {
    return blob;
  }
}

function googleSlidesId(value: string): string | null {
  if (!value || value.length > 8192) return null;
  const candidates = [value.trim(), ...(value.match(/https:\/\/[^\s<>"']+/gi) ?? [])];

  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (url.protocol !== "https:") continue;

      if (url.hostname === "docs.google.com") {
        const match = url.pathname.match(/^\/presentation\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,})(?:\/|$)/);
        const queryId = url.pathname === "/open" ? url.searchParams.get("id") : null;
        if (match?.[1]) return match[1];
        if (queryId && /^[A-Za-z0-9_-]{10,}$/.test(queryId)) return queryId;
      }

      if (url.hostname === "drive.google.com") {
        const match = url.pathname.match(/^\/file\/d\/([A-Za-z0-9_-]{10,})(?:\/|$)/);
        const queryId = url.searchParams.get("id");
        if (match?.[1]) return match[1];
        if (queryId && /^[A-Za-z0-9_-]{10,}$/.test(queryId)) return queryId;
      }
    } catch {
      // Try the next URL found in pasted share text.
    }
  }

  return null;
}

function isPublishedLink(value: string): boolean {
  return /docs\.google\.com\/presentation\/(?:u\/\d+\/)?d\/e\//i.test(value);
}

function googleAccessError(status: number) {
  if (status === 429) {
    return Response.json({ error: "Google is rate-limiting exports. Wait a moment and try again." }, { status: 429 });
  }
  if (status >= 500) {
    return Response.json({ error: "Google Slides export is temporarily unavailable. Try again." }, { status: 502 });
  }
  return Response.json(
    {
      error:
        status === 404
          ? "Google Slides presentation was not found."
          : "Google could not export this presentation. Share it as 'Anyone with the link' and allow viewers to download.",
    },
    { status: status === 404 ? 404 : 403 },
  );
}

function exportedFileName(disposition: string | null): string {
  const encoded = disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = disposition?.match(/filename="?([^";]+)"?/i)?.[1];
  let candidate = "Google Slides presentation.pptx";
  try {
    if (encoded) candidate = decodeURIComponent(encoded);
    else if (plain) candidate = plain;
  } catch {
    // Keep the safe fallback.
  }
  const safe = candidate.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 180);
  return safe.toLowerCase().endsWith(".pptx") ? safe : `${safe || "Google Slides presentation"}.pptx`;
}
