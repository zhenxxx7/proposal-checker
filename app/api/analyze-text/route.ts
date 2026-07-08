import { askForFindings } from "@/lib/ai/client";

export const maxDuration = 300;

interface Body {
  slides: { n: number; texts: string[] }[];
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
  const { slides } = (await req.json()) as Body;
  if (!Array.isArray(slides) || !slides.length) return Response.json({ findings: [] });

  const deck = slides.map((s) => `--- SLIDE ${s.n} ---\n${s.texts.join("\n")}`).join("\n\n");

  try {
    const findings = await askForFindings(SYSTEM, [
      { type: "text", text: `Proofread this deck. ${slides.length} slides.\n\n${deck}` },
    ]);
    return Response.json({ findings });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ findings: [], error: message }, { status: 502 });
  }
}
