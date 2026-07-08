import { askForFindings } from "@/lib/ai/client";

export const maxDuration = 300;

interface Body {
  slide: number;
  /** base64, no data: prefix */
  image: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  /** text sitting on the same slide, for terminology cross-checks */
  slideText?: string;
  displayPx?: { w: number; h: number };
}

const SYSTEM = `You inspect images embedded in a client proposal deck — usually UI mockups, app screens, or annotated diagrams. Typos hide inside these images because no spell-checker ever sees them.

Read every piece of text rendered in the image: buttons, labels, nav items, headings, body copy, form fields, tooltips, captions, chart axes, watermarks. Then report:
- Spelling mistakes and typos in the image text.
- Grammar errors in sentences shown in the UI.
- Text that is clipped, truncated, or overflowing its container so a word is cut off.
- Placeholder content that should not ship: "Lorem ipsum", "Your text here", "Label", obviously fake data presented as real.
- Terminology that contradicts the slide text supplied below (same feature named two ways).
- Text so small or low-contrast that it is unreadable at the size the image occupies on the slide.

Always use category "image-text". Set "quote" to the exact text as it appears in the image, and "suggestion" to the corrected text. In "detail", say where in the image it is ("primary CTA button", "left sidebar, third nav item") so the designer can find it.

Do NOT report:
- Design or layout opinions, colour choices, spacing.
- Realistic sample data (names, prices, dates) — mockups are supposed to have those.
- Brand names, product names, or non-English words you do not recognise.
- Text you cannot read confidently. Skip it rather than guess.

Respond with JSON only, matching: {"findings":[{"slide":1,"severity":"error","category":"image-text","quote":"...","suggestion":"...","detail":"..."}]}
If the image has no text, or the text is clean, return {"findings":[]}. That is the expected result for most images.`;

export async function POST(req: Request) {
  const { slide, image, mediaType, slideText, displayPx } = (await req.json()) as Body;

  if (!image || !mediaType) {
    return Response.json({ findings: [], error: "image and mediaType required" }, { status: 400 });
  }

  const context = [
    `This image appears on slide ${slide}.`,
    displayPx ? `It is rendered at ${displayPx.w}×${displayPx.h}px on the slide.` : "",
    slideText?.trim() ? `Text on the same slide, for terminology cross-checks:\n"""\n${slideText.trim()}\n"""` : "",
    `Report findings against slide ${slide}.`,
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const findings = await askForFindings(SYSTEM, [
      { type: "image_url", image_url: { url: `data:${mediaType};base64,${image}` } },
      { type: "text", text: context },
    ]);
    // The model is told the slide number but often echoes 1; force it.
    return Response.json({ findings: findings.map((f) => ({ ...f, slide, category: "image-text" as const })) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ findings: [], error: message }, { status: 502 });
  }
}
