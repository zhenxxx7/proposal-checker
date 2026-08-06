import { px96, type Deck, type Shape } from "../types";
import { isVisibleOnSlide } from "../visibility";

/** Compact, grounded layout evidence sent to the primary deck evaluator. */
export interface DeckAuditBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DeckAuditShape {
  id: string;
  kind: "text" | "image" | "connector";
  bounds: DeckAuditBounds;
  rotation?: number;
  image?: {
    sourcePx: { w: number; h: number };
    displayPx: { w: number; h: number };
  };
}

export interface DeckAuditSlide {
  n: number;
  texts: string[];
  shapes: DeckAuditShape[];
}

const MAX_SHAPES_PER_SLIDE = 48;
const MAX_TEXTS_PER_SLIDE = 240;
const MAX_TEXT_CHARS = 4_000;

/**
 * Geometry is evidence, not a rule result. Gemini decides whether a difference
 * is a real client-visible defect. Bounds remain relative to canvas so slides
 * with different PowerPoint dimensions compare consistently.
 */
export function deckAuditSlides(deck: Deck): DeckAuditSlide[] {
  return deck.slides.map((slide) => {
    const shapes = [...(slide.backgroundShapes ?? []), ...slide.shapes]
      .filter((shape) => isVisibleOnSlide(shape, deck.widthEmu, deck.heightEmu))
      .sort((a, b) => shapePriority(b) - shapePriority(a))
      .slice(0, MAX_SHAPES_PER_SLIDE)
      .map((shape) => auditShape(shape, deck));
    const texts = slide.shapes
      .flatMap((shape) =>
        shape.kind === "text" && isVisibleOnSlide(shape, deck.widthEmu, deck.heightEmu)
          ? shape.paragraphs.map((paragraph) => paragraph.text)
          : [],
      )
      .filter(Boolean)
      .slice(0, MAX_TEXTS_PER_SLIDE)
      .map((text) => text.slice(0, MAX_TEXT_CHARS));
    return { n: slide.index, texts, shapes };
  });
}

function auditShape(shape: Shape, deck: Deck): DeckAuditShape {
  const bounds = {
    x: rounded(shape.rect.x / deck.widthEmu),
    y: rounded(shape.rect.y / deck.heightEmu),
    w: rounded(shape.rect.w / deck.widthEmu),
    h: rounded(shape.rect.h / deck.heightEmu),
  };
  if (shape.kind === "pic") {
    const media = deck.media.get(shape.media);
    return {
      id: shape.id,
      kind: "image",
      bounds,
      rotation: rounded(shape.rot),
      ...(media
        ? {
            image: {
              sourcePx: { w: media.width, h: media.height },
              displayPx: { w: Math.round(px96(shape.rect.w)), h: Math.round(px96(shape.rect.h)) },
            },
          }
        : {}),
    };
  }
  if (shape.kind === "cxn") {
    return { id: shape.id, kind: "connector", bounds };
  }
  return { id: shape.id, kind: "text", bounds, rotation: rounded(shape.rot) };
}

/** Text and large visual elements remain when a slide contains a logo wall. */
function shapePriority(shape: Shape): number {
  const area = Math.max(0, shape.rect.w * shape.rect.h);
  return area + (shape.kind === "text" ? Number.MAX_SAFE_INTEGER / 4 : 0);
}

function rounded(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
