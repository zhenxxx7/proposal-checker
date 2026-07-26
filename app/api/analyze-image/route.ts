import { askForFindings } from "@/lib/ai/client";
import { aiConfig } from "@/lib/ai/config";
import { IMAGE_SYSTEM_PROMPT, promptVersionFor } from "@/lib/ai/prompts";
import { resolveSharedFeedbackPromptMemory } from "@/lib/feedbackServer";
import { boundedJsonError, isTrustedOrigin, readBoundedJson } from "@/lib/requestGuards";

export const maxDuration = 300;

// One downscaled JPEG as base64; Vercel rejects bodies above ~4.5MB anyway.
const MAX_BODY_BYTES = 5 * 1024 * 1024;

interface Body {
  slide: number;
  /** base64, no data: prefix */
  image: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  displayPx?: { w: number; h: number };
  deckFingerprint?: unknown;
}

export async function POST(req: Request) {
  // This route spends paid AI tokens; scripted non-browser calls are refused.
  if (!isTrustedOrigin(req)) return Response.json({ findings: [], error: "Forbidden" }, { status: 403 });
  const parsed = await readBoundedJson(req, MAX_BODY_BYTES);
  if (!parsed.ok) {
    return Response.json({ findings: [], ...boundedJsonError(parsed.status) }, { status: parsed.status });
  }
  const { slide, image, mediaType, displayPx, deckFingerprint: requestedDeckFingerprint } = parsed.value as Body;

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
    const result = await askForFindings(
      `${IMAGE_SYSTEM_PROMPT}${feedbackMemory.prompt}`,
      [
        { type: "image_url", image_url: { url: `data:${mediaType};base64,${image}` } },
        { type: "text", text: context },
      ],
      aiConfig("image"),
    );
    // The model is told the slide number but often echoes 1; force it.
    return Response.json({
      findings: result.findings.map((f) => ({ ...f, slide, category: "image-text" as const })),
      // Actual serving provenance — the browser stamps it into feedback records.
      model: { provider: result.provider, name: result.model },
      promptVersion: promptVersionFor("ai-image"),
      analysisInput: null,
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
