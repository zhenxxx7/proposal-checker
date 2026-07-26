import { askForFindings } from "@/lib/ai/client";
import { resolveSharedFeedbackPromptMemory } from "@/lib/feedbackServer";

export const maxDuration = 300;

interface Body {
  slide: number;
  /** base64, no data: prefix */
  image: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  displayPx?: { w: number; h: number };
  deckFingerprint?: unknown;
}

const SYSTEM = `You inspect images embedded in a client proposal deck — usually UI mockups, app screens, or annotated diagrams. Review only intentionally legible, user-facing copy.

Report:
- Spelling mistakes and typos in the image text.
- Grammar errors in sentences shown in the UI.
- Placeholder content that should not ship: "Lorem ipsum", "Your text here", "Label", obviously fake data presented as real.
- Clipping only when a clearly legible glyph visibly crosses or is cut by its container boundary.

Always use category "image-text". Set "quote" to the exact text as it appears in the image, and "suggestion" to the corrected text. In "detail", say where in the image it is ("primary CTA button", "left sidebar, third nav item") so the designer can find it.

Do NOT report:
- Differences between explanatory text outside the mockup and labels inside it. Explanatory slide copy may intentionally paraphrase the mockup.
- Tiny text used as scenery inside monitors, documents, signs, or distant background objects.
- Apparent missing letters, clipping, placeholders, or typos caused by blur, pixelation, compression, scaling, or low source resolution.
- Text that is too small, low-contrast, or unclear to transcribe confidently. Skip it rather than infer what it says.
- Design or layout opinions, colour choices, spacing.
- Realistic sample data (names, prices, dates) — mockups are supposed to have those.
- Brand names, product names, or non-English words you do not recognise.

Respond with JSON only, matching: {"findings":[{"slide":1,"severity":"error","category":"image-text","quote":"...","suggestion":"...","detail":"..."}]}
If the image has no text, or the text is clean, return {"findings":[]}. That is the expected result for most images.`;

export async function POST(req: Request) {
  const { slide, image, mediaType, displayPx, deckFingerprint: requestedDeckFingerprint } = (await req.json()) as Body;

  if (!image || !mediaType) {
    return Response.json({ findings: [], error: "image and mediaType required" }, { status: 400 });
  }

  const context = [
    `This image appears on slide ${slide}.`,
    displayPx ? `It is rendered at ${displayPx.w}×${displayPx.h}px on the slide.` : "",
    `Report findings against slide ${slide}.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const feedbackMemory = await promptMemory("ai-image", deckFingerprint(requestedDeckFingerprint));

  try {
    const findings = await askForFindings(`${SYSTEM}${feedbackMemory.prompt}`, [
      { type: "image_url", image_url: { url: `data:${mediaType};base64,${image}` } },
      { type: "text", text: context },
    ]);
    // The model is told the slide number but often echoes 1; force it.
    return Response.json({
      findings: findings.map((f) => ({ ...f, slide, category: "image-text" as const })),
      feedbackMemory: feedbackMeta(feedbackMemory),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ findings: [], error: message }, { status: 502 });
  }
}

async function promptMemory(source: "ai-text" | "ai-image", fingerprint?: string) {
  try {
    return await resolveSharedFeedbackPromptMemory({ source, deckFingerprint: fingerprint });
  } catch (error) {
    console.error("Shared feedback prompt lookup failed", error);
    return { configured: false, examples: [], prompt: "" };
  }
}

function feedbackMeta(memory: Awaited<ReturnType<typeof promptMemory>>) {
  return { configured: memory.configured, applied: memory.examples.length };
}

function deckFingerprint(value: unknown): string | undefined {
  return typeof value === "string" && /^deck-v1-[a-f0-9]{16}$/.test(value) ? value : undefined;
}
