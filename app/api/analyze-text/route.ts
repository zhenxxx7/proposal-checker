import { askForFindings } from "@/lib/ai/client";
import { resolveSharedFeedbackPromptMemory } from "@/lib/feedbackServer";
import { boundedJsonError, isTrustedOrigin, readBoundedJson } from "@/lib/requestGuards";

export const maxDuration = 300;

// Slide text only; a full deck of prose stays far below this.
const MAX_BODY_BYTES = 2 * 1024 * 1024;

interface Body {
  slides: { n: number; texts: string[] }[];
  deckFingerprint?: unknown;
}

const SYSTEM = `You proofread client-facing proposal decks before they are submitted. You are the last set of eyes.

Report ONLY defects a client would notice:
- Real spelling mistakes and typos.
- Grammar errors that change meaning or read as careless.
- Terminology inconsistency across slides: the same product, feature, or client name spelled, capitalised, hyphenated, or spaced two different ways.
- Placeholder or internal text that should never ship (lorem ipsum, TBD, XXX, draft notes, "[insert]").
- Punctuation errors: missing terminal punctuation in body copy, doubled marks, mismatched quotes.

Do NOT report:
- Style preferences, tone, or wording you would merely phrase differently.
- Deliberate brand casing (e.g. "iPhone", "YesterYears") unless the SAME term appears differently elsewhere in the deck.
- Sentence fragments in headings, bullets, or labels — decks are written that way on purpose.
- Missing full stops on headings, titles, or single-word labels.
- Proper nouns, product names, or acronyms you simply do not recognise.

"quote" must be copied verbatim from the slide text so the user can search for it. "suggestion" is the corrected text only. Set severity to "error" for a clear mistake, "warn" for probable, "info" for a judgement call.

Respond with JSON only, matching: {"findings":[{"slide":1,"severity":"error","category":"typo","quote":"...","suggestion":"...","detail":"..."}]}
If the deck is clean, return {"findings":[]}. An empty array is a valid and common answer.`;

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
    const findings = await askForFindings(`${SYSTEM}${feedbackMemory.prompt}`, [
      { type: "text", text: `Proofread this deck. ${slides.length} slides.\n\n${deck}` },
    ]);
    return Response.json({ findings, feedbackMemory: feedbackMeta(feedbackMemory) });
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
