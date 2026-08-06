import type { Category, Code, Finding, Severity } from "./types";

export interface Group {
  key: string;
  icon: string;
  /** "6 images will look blurry" */
  title: string;
  /** why a reader should care, in one line */
  why: string;
  severity: Severity;
  findings: Finding[];
  slides: number[];
}

interface Def {
  key: string;
  icon: string;
  codes: Code[];
  title: (n: number) => string;
  why: string;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many.replace("{n}", String(n)));

/**
 * Order matters: the summary lists groups by severity, then by this order.
 * Codes not claimed by any def fall into a catch-all.
 */
const DEFS: Def[] = [
  {
    key: "blurry",
    icon: "🔍",
    codes: ["img.upscaled"],
    title: (n) => plural(n, "An image will look blurry", "{n} images will look blurry"),
    why: "Enlarged past their real pixel size. Obvious on a projector.",
  },
  {
    key: "distorted",
    icon: "↔️",
    codes: ["img.distorted"],
    title: (n) => plural(n, "An image is stretched out of proportion", "{n} images are stretched out of proportion"),
    why: "Logos, faces, and circles look wrong when the aspect ratio is off.",
  },
  {
    key: "typos",
    icon: "✏️",
    codes: ["text.repeated-word", "text.placeholder"],
    title: (n) => plural(n, "A typo or leftover placeholder", "{n} typos and leftover placeholders"),
    why: "The kind of mistake a client notices immediately.",
  },
  {
    key: "in-image",
    icon: "🖼️",
    codes: ["ai.image"],
    title: (n) => plural(n, "An issue in a mockup image", "{n} issues inside mockup images"),
    why: "Text baked into screenshots — no spell-checker ever sees it.",
  },
  {
    key: "proofread",
    icon: "📝",
    codes: ["ai.text"],
    title: (n) => plural(n, "A proofreading note", "{n} proofreading notes"),
    why: "Grammar and wording flagged by the AI pass.",
  },
  {
    key: "readability",
    icon: "👁",
    codes: ["text.low-contrast"],
    title: (n) => plural(n, "Text is nearly invisible", "{n} pieces of text are nearly invisible"),
    why: "Text and background colours almost match — unreadable when projected.",
  },
  {
    key: "duplicate",
    icon: "⧉",
    codes: ["slide.duplicate"],
    title: (n) => plural(n, "A slide looks duplicated", "{n} sets of duplicated slides"),
    why: "Same images and text on more than one slide — usually a copy-paste left behind.",
  },
  {
    key: "terminology",
    icon: "🔤",
    codes: ["term.spelling-variant", "term.case-drift"],
    title: (n) => plural(n, "A term is written two ways", "{n} terms are written two ways"),
    why: "Inconsistent naming makes a proposal read as rushed.",
  },
  {
    key: "mismatched",
    icon: "📐",
    codes: ["img.sibling-size", "img.same-nudged", "img.hero-width"],
    title: (n) => plural(n, "Two images that should match, don't", "{n} images that should match, don't"),
    why: "Sizes are close but not equal — almost always an accident.",
  },
  {
    key: "misaligned",
    icon: "📏",
    codes: ["img.sibling-align"],
    title: (n) => plural(n, "An image is slightly out of alignment", "{n} images are slightly out of alignment"),
    why: "A few pixels off. Reads as sloppy even if nobody can name why.",
  },
  {
    key: "spacing",
    icon: "␣",
    codes: [
      "text.double-space",
      "text.space-before-punct",
      "text.missing-space",
      "text.doubled-punct",
      "text.unbalanced",
      "text.lowercase-sentence",
    ],
    title: (n) => plural(n, "A spacing or punctuation slip", "{n} spacing and punctuation slips"),
    why: "Small, but they add up across a long deck.",
  },
  {
    key: "layout",
    icon: "🚧",
    codes: ["geo.text-overflow", "geo.pic-offslide"],
    title: (n) => plural(n, "Something runs off the slide", "{n} things run off the slide"),
    why: "Content past the canvas edge may be cut off when presented.",
  },
  {
    key: "cleanup",
    icon: "🧹",
    codes: ["img.oversized", "style.mixed-quotes", "style.title-size", "style.font-drift", "term.case-styling"],
    title: (n) => plural(n, "A housekeeping note", "{n} housekeeping notes"),
    why: "File bloat and style drift. Nothing urgent.",
  },
];

interface AiDeckDef {
  key: string;
  icon: string;
  categories: Category[];
  title: (n: number) => string;
  why: string;
}

/** All normal-app findings now come from Gemini's unified deck review. */
const AI_DECK_DEFS: AiDeckDef[] = [
  {
    key: "ai-copy",
    icon: "✏️",
    categories: ["typo", "grammar", "spacing", "punctuation", "capitalization", "placeholder"],
    title: (n) => plural(n, "An AI copy issue", "{n} AI copy issues"),
    why: "Gemini found client-visible wording or placeholder problems.",
  },
  {
    key: "ai-consistency",
    icon: "🔤",
    categories: ["consistency"],
    title: (n) => plural(n, "An AI consistency issue", "{n} AI consistency issues"),
    why: "Gemini found a term or style that conflicts across slides.",
  },
  {
    key: "ai-layout",
    icon: "📐",
    categories: ["alignment", "geometry"],
    title: (n) => plural(n, "An AI layout issue", "{n} AI layout issues"),
    why: "Gemini judged the positioning or visible geometry as client-facing.",
  },
  {
    key: "ai-image-quality",
    icon: "🖼️",
    categories: ["resolution", "aspect", "image-text"],
    title: (n) => plural(n, "An AI image issue", "{n} AI image issues"),
    why: "Gemini found a visible image or mockup problem.",
  },
];

const WORST: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

export function groupFindings(findings: Finding[]): Group[] {
  const claimed = new Map<Code, Def>();
  for (const def of DEFS) for (const c of def.codes) claimed.set(c, def);
  const aiDeckByCategory = new Map<Category, AiDeckDef>();
  for (const def of AI_DECK_DEFS) for (const category of def.categories) aiDeckByCategory.set(category, def);

  const buckets = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = f.code === "ai.deck" ? aiDeckByCategory.get(f.category)?.key ?? "ai-other" : claimed.get(f.code)?.key ?? "other";
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(f);
  }

  const groups: Group[] = [];
  for (const def of AI_DECK_DEFS) {
    const items = buckets.get(def.key);
    if (!items?.length) continue;
    groups.push(build(def.key, def.icon, def.title(items.length), def.why, items));
  }
  for (const def of DEFS) {
    const items = buckets.get(def.key);
    if (!items?.length) continue;
    groups.push(build(def.key, def.icon, def.title(items.length), def.why, items));
  }
  const aiOther = buckets.get("ai-other");
  if (aiOther?.length) groups.push(build("ai-other", "✦", `${aiOther.length} other AI findings`, "Gemini found a concrete deck issue.", aiOther));
  const rest = buckets.get("other");
  if (rest?.length) groups.push(build("other", "•", `${rest.length} other findings`, "", rest));

  return groups.sort(
    (a, b) => WORST[a.severity] - WORST[b.severity] || b.findings.length - a.findings.length,
  );
}

function build(key: string, icon: string, title: string, why: string, findings: Finding[]): Group {
  const severity = findings.reduce<Severity>(
    (worst, f) => (WORST[f.severity] < WORST[worst] ? f.severity : worst),
    "info",
  );
  const slides = [...new Set(findings.flatMap((f) => [f.slide, ...(f.relatedSlides ?? [])]))].sort((a, b) => a - b);
  return { key, icon, title, why, severity, findings, slides };
}

export type Readiness = "blocked" | "almost" | "ready";

export function readiness(findings: Finding[]): Readiness {
  if (findings.some((f) => f.severity === "error")) return "blocked";
  if (findings.some((f) => f.severity === "warn")) return "almost";
  return "ready";
}
