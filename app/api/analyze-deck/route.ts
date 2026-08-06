import { askForFindings } from "@/lib/ai/client";
import { type DeckAuditShape, type DeckAuditSlide } from "@/lib/ai/deckAudit";
import { DECK_SYSTEM_PROMPT, promptVersionFor } from "@/lib/ai/prompts";
import { type AiFinding } from "@/lib/ai/schema";
import { resolveAiConfig } from "@/lib/ai/registry";
import { captureAnalysisInput } from "@/lib/analysisInputs";
import { resolveSharedFeedbackPromptMemory } from "@/lib/feedbackServer";
import { boundedJsonError, isTrustedOrigin, readBoundedJson } from "@/lib/requestGuards";
import { normQuote } from "@/lib/textNorm";

export const maxDuration = 300;

// Structured text + compact geometry metadata, never preview pixels or PPTX bytes.
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_SLIDES = 150;
const MAX_TEXTS_PER_SLIDE = 240;
const MAX_SHAPES_PER_SLIDE = 48;

interface Body {
  slides: unknown;
  deckFingerprint?: unknown;
}

export async function POST(req: Request) {
  if (!isTrustedOrigin(req)) return Response.json({ findings: [], error: "Forbidden" }, { status: 403 });
  const parsed = await readBoundedJson(req, MAX_BODY_BYTES);
  if (!parsed.ok) return Response.json({ findings: [], ...boundedJsonError(parsed.status) }, { status: parsed.status });

  const { slides: rawSlides, deckFingerprint: requestedDeckFingerprint } = parsed.value as Body;
  const slides = parseAuditSlides(rawSlides);
  if (!slides?.length) return Response.json({ findings: [], error: "Invalid deck audit payload" }, { status: 400 });

  const fingerprint = deckFingerprint(requestedDeckFingerprint);
  const feedbackMemory = await promptMemory(fingerprint);
  const userPrompt = `Review this ${slides.length}-slide proposal deck. The JSON is evidence for your review.\n\n${JSON.stringify({ slides })}`;

  try {
    const result = await askForFindings(
      `${DECK_SYSTEM_PROMPT}${feedbackMemory.prompt}`,
      [{ type: "text", text: userPrompt }],
      await resolveAiConfig("text"),
    );
    const findings = groundFindings(result.findings, slides);
    const analysisInput = fingerprint
      ? await captureAnalysisInput({
          deckFingerprint: fingerprint,
          source: "ai-deck",
          promptVersion: promptVersionFor("ai-deck"),
          payload: { slides },
          feedbackMemory: feedbackMemory.examples.length ? feedbackMemory.examples : null,
          provider: result.provider,
          model: result.model,
          responseFindings: findings,
          responseFormatMode: result.responseFormatMode,
        })
      : null;
    return Response.json({
      findings,
      model: { provider: result.provider, name: result.model },
      promptVersion: promptVersionFor("ai-deck"),
      analysisInput,
      feedbackMemory: { configured: feedbackMemory.configured, applied: feedbackMemory.examples.length },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ findings: [], error: message }, { status: 502 });
  }
}

function groundFindings(findings: readonly AiFinding[], slides: readonly DeckAuditSlide[]): AiFinding[] {
  const slideNumbers = new Set(slides.map((slide) => slide.n));
  const textBySlide = new Map(slides.map((slide) => [slide.n, normQuote(slide.texts.join("\n"))]));
  const shapeIdsBySlide = new Map(slides.map((slide) => [slide.n, new Set(slide.shapes.map((shape) => shape.id))]));

  const output: AiFinding[] = [];
  for (const finding of findings) {
    if (!slideNumbers.has(finding.slide)) continue;
    if (finding.quote && !(textBySlide.get(finding.slide) ?? "").includes(normQuote(finding.quote))) continue;
    const shapeIds = finding.shapeIds?.filter((id) => shapeIdsBySlide.get(finding.slide)?.has(id));
    const relatedSlides = finding.relatedSlides?.filter((slide) => slide !== finding.slide && slideNumbers.has(slide));
    // Every quote-less finding needs a real structural or cross-slide anchor.
    if (!finding.quote && !shapeIds?.length && !relatedSlides?.length) continue;
    output.push({
      ...finding,
      ...(shapeIds?.length ? { shapeIds: [...new Set(shapeIds)] } : {}),
      ...(relatedSlides?.length ? { relatedSlides: [...new Set(relatedSlides)] } : {}),
    });
  }
  return output;
}

function parseAuditSlides(value: unknown): DeckAuditSlide[] | null {
  if (!Array.isArray(value) || !value.length || value.length > MAX_SLIDES) return null;
  const seenSlides = new Set<number>();
  const slides: DeckAuditSlide[] = [];
  for (const item of value) {
    if (!isObject(item) || !positiveInteger(item.n) || seenSlides.has(item.n)) return null;
    if (!Array.isArray(item.texts) || item.texts.length > MAX_TEXTS_PER_SLIDE) return null;
    if (!Array.isArray(item.shapes) || item.shapes.length > MAX_SHAPES_PER_SLIDE) return null;
    const texts = item.texts.filter((text): text is string => typeof text === "string" && text.length <= 4_000);
    if (texts.length !== item.texts.length) return null;
    const parsedShapes = item.shapes.map(parseShape);
    if (parsedShapes.some((shape) => shape === null)) return null;
    const shapes = parsedShapes.filter((shape): shape is DeckAuditShape => shape !== null);
    const ids = new Set(shapes.map((shape) => shape.id));
    if (ids.size !== shapes.length) return null;
    seenSlides.add(item.n);
    slides.push({ n: item.n, texts, shapes });
  }
  return slides;
}

function parseShape(value: unknown): DeckAuditShape | null {
  if (!isObject(value) || typeof value.id !== "string" || !value.id || value.id.length > 256) return null;
  if (value.kind !== "text" && value.kind !== "image" && value.kind !== "connector") return null;
  if (!isObject(value.bounds) || !finiteBounds(value.bounds)) return null;
  const rotation = typeof value.rotation === "number" && Number.isFinite(value.rotation) ? value.rotation : undefined;
  const base: DeckAuditShape = {
    id: value.id,
    kind: value.kind,
    bounds: { x: value.bounds.x, y: value.bounds.y, w: value.bounds.w, h: value.bounds.h },
    ...(rotation === undefined ? {} : { rotation }),
  };
  if (value.kind !== "image") return base;
  if (value.image === undefined) return base;
  if (!isObject(value.image) || !isObject(value.image.sourcePx) || !isObject(value.image.displayPx)) return null;
  if (!positiveInteger(value.image.sourcePx.w) || !positiveInteger(value.image.sourcePx.h)) return null;
  if (!positiveInteger(value.image.displayPx.w) || !positiveInteger(value.image.displayPx.h)) return null;
  return {
    ...base,
    image: {
      sourcePx: { w: value.image.sourcePx.w, h: value.image.sourcePx.h },
      displayPx: { w: value.image.displayPx.w, h: value.image.displayPx.h },
    },
  };
}

function finiteBounds(value: Record<string, unknown>): value is { x: number; y: number; w: number; h: number } {
  return [value.x, value.y, value.w, value.h].every((coordinate) =>
    typeof coordinate === "number" && Number.isFinite(coordinate) && coordinate >= -2 && coordinate <= 3,
  );
}

async function promptMemory(deckFingerprint?: string) {
  try {
    return await resolveSharedFeedbackPromptMemory({ source: "ai-deck", deckFingerprint });
  } catch (error) {
    console.error("Shared feedback prompt lookup failed", error);
    return { configured: false, examples: [], prompt: "" };
  }
}

function deckFingerprint(value: unknown): string | undefined {
  return typeof value === "string" && /^deck-v1-[a-f0-9]{16}$/.test(value) ? value : undefined;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
