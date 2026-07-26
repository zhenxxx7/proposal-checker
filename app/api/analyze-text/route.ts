import { askForFindings } from "@/lib/ai/client";
import { aiConfig } from "@/lib/ai/config";
import { promptVersionFor, TEXT_SYSTEM_PROMPT } from "@/lib/ai/prompts";
import { resolveSharedFeedbackPromptMemory } from "@/lib/feedbackServer";
import { boundedJsonError, isTrustedOrigin, readBoundedJson } from "@/lib/requestGuards";

export const maxDuration = 300;

// Slide text only; a full deck of prose stays far below this.
const MAX_BODY_BYTES = 2 * 1024 * 1024;

interface Body {
  slides: { n: number; texts: string[] }[];
  deckFingerprint?: unknown;
}

export async function POST(req: Request) {
  // This route spends paid AI tokens; scripted non-browser calls are refused.
  if (!isTrustedOrigin(req)) return Response.json({ findings: [], error: "Forbidden" }, { status: 403 });
  const parsed = await readBoundedJson(req, MAX_BODY_BYTES);
  if (!parsed.ok) {
    return Response.json({ findings: [], ...boundedJsonError(parsed.status) }, { status: parsed.status });
  }
  const { slides, deckFingerprint: requestedDeckFingerprint } = parsed.value as Body;
  if (!Array.isArray(slides) || !slides.length) return Response.json({ findings: [] });

  const deck = slides.map((s) => `--- SLIDE ${s.n} ---\n${s.texts.join("\n")}`).join("\n\n");
  const feedbackMemory = await promptMemory("ai-text", deckFingerprint(requestedDeckFingerprint));

  try {
    const result = await askForFindings(
      `${TEXT_SYSTEM_PROMPT}${feedbackMemory.prompt}`,
      [{ type: "text", text: `Proofread this deck. ${slides.length} slides.\n\n${deck}` }],
      aiConfig("text"),
    );
    return Response.json({
      findings: result.findings,
      // Actual serving provenance — the browser stamps it into feedback records.
      model: { provider: result.provider, name: result.model },
      promptVersion: promptVersionFor("ai-text"),
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
