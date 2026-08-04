import type { Deck } from "./types";
import type { DeckCaptureRecord, DeckCaptureSource } from "./deckServer";

export interface DeckSourceInfo {
  source: DeckCaptureSource;
  sourceUrl?: string;
}

/** Sends text/metadata useful for tuning; never sends PPTX bytes or preview pixels. */
export function createDeckCaptureRecord(
  name: string,
  deck: Deck,
  sourceInfo: DeckSourceInfo,
  fingerprint: string,
): DeckCaptureRecord {
  return {
    deckFingerprint: fingerprint,
    name,
    source: sourceInfo.source,
    ...(sourceInfo.sourceUrl ? { sourceUrl: sourceInfo.sourceUrl } : {}),
    slideCount: deck.slides.length,
    widthEmu: deck.widthEmu,
    heightEmu: deck.heightEmu,
    slides: deck.slides.map((slide) => {
      const shapes = [...(slide.backgroundShapes ?? []), ...slide.shapes];
      const textShapes = shapes.filter((shape) => shape.kind === "text");
      return {
        index: slide.index,
        texts: textShapes.flatMap((shape) => shape.paragraphs.map((paragraph) => paragraph.text)),
        shapeCount: shapes.length,
        textShapeCount: textShapes.length,
        imageCount: shapes.filter((shape) => shape.kind === "pic").length,
      };
    }),
    media: [...deck.media.values()].map((media) => ({
      format: media.format,
      bytes: media.bytes,
      width: media.width,
      height: media.height,
    })),
  };
}

/** Best effort: database capture must never block deck checking. */
export async function storeDeckCapture(record: DeckCaptureRecord): Promise<boolean> {
  try {
    const response = await fetch("/api/decks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ record }),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { stored?: unknown };
    return body.stored === true;
  } catch {
    return false;
  }
}

