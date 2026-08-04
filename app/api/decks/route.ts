import { deckCaptureConfigured, saveDeckCapture, type DeckCaptureRecord } from "@/lib/deckServer";
import { boundedJsonError, isTrustedOrigin, readBoundedJson } from "@/lib/requestGuards";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 384 * 1024;

export async function POST(request: Request) {
  if (!deckCaptureConfigured()) return Response.json({ stored: false, configured: false });
  if (!isTrustedOrigin(request)) return Response.json({ error: "Forbidden" }, { status: 403 });
  const body = await readBoundedJson(request, MAX_BODY_BYTES);
  if (!body.ok) return Response.json(boundedJsonError(body.status), { status: body.status });
  const record = isObject(body.value) ? body.value.record : undefined;
  if (!isDeckCaptureRecord(record)) return Response.json({ error: "Invalid deck capture" }, { status: 400 });

  try {
    const saved = await saveDeckCapture(record);
    return Response.json({ stored: Boolean(saved), configured: true, id: saved?.id ?? null }, { status: 201 });
  } catch (error) {
    console.error("Deck capture write failed", error);
    return Response.json({ stored: false, configured: true });
  }
}

function isDeckCaptureRecord(value: unknown): value is DeckCaptureRecord {
  if (!isObject(value)) return false;
  if (typeof value.deckFingerprint !== "string" || !/^deck-v1-[a-f0-9]{16}$/.test(value.deckFingerprint)) return false;
  if (typeof value.name !== "string" || value.name.length < 1 || value.name.length > 512) return false;
  if (value.source !== "upload" && value.source !== "google-slides") return false;
  if (value.sourceUrl !== undefined && (typeof value.sourceUrl !== "string" || value.sourceUrl.length > 8192)) return false;
  const slideCount = value.slideCount;
  if (typeof slideCount !== "number" || !Number.isSafeInteger(slideCount) || slideCount < 1 || slideCount > 10_000) return false;
  if (!Number.isSafeInteger(value.widthEmu) || !Number.isSafeInteger(value.heightEmu)) return false;
  if (!Array.isArray(value.slides) || value.slides.length !== slideCount || value.slides.length > 10_000) return false;
  if (!Array.isArray(value.media) || value.media.length > 10_000) return false;
  return value.slides.every((slide) => {
    if (!isObject(slide)) return false;
    return (
      Number.isSafeInteger(slide.index) &&
      Array.isArray(slide.texts) &&
      slide.texts.length <= 10_000 &&
      slide.texts.every((text) => typeof text === "string" && text.length <= 20_000) &&
      [slide.shapeCount, slide.textShapeCount, slide.imageCount].every(
        (count) => Number.isSafeInteger(count) && Number(count) >= 0,
      )
    );
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
