import {
  EMU_PER_INCH,
  inches,
  type Code,
  type Deck,
  type Finding,
  type PicShape,
  type Rect,
  type Severity,
  type Shape,
  type TextShape,
} from "./types";

let seq = 0;
const mk = (f: Omit<Finding, "id" | "source">): Finding => ({ ...f, id: `r${++seq}`, source: "rule" });

/** A picture small enough to be an icon, bullet, or logo is not a "layout sibling". */
const CONTENT_AREA_FRAC = 0.03;
/** Logo walls and icon grids: pairwise comparison there is meaningless. */
const MAX_SIBLINGS = 10;

export function runRuleChecks(deck: Deck): Finding[] {
  seq = 0;
  return [
    ...deck.slides.flatMap((s) => textChecks(s.index, s.shapes.filter(isText))),
    ...deck.slides.flatMap((s) => imageChecks(deck, s.index, s.shapes.filter(isPic))),
    ...geometryChecks(deck),
    ...deckTextConsistency(deck),
    ...deckImageConsistency(deck),
    ...duplicateSlides(deck),
  ];
}

const isPic = (s: Shape): s is PicShape => s.kind === "pic";
const isText = (s: Shape): s is TextShape => s.kind === "text";

// ============================================================ text, per slide

interface Rule {
  code: Code;
  re: RegExp;
  category: Finding["category"];
  severity: Severity;
  title: string;
  detail: (m: RegExpExecArray) => string;
  suggestion?: (m: RegExpExecArray) => string;
}

const TEXT_RULES: Rule[] = [
  {
    code: "text.double-space",
    re: /\S(  +)\S/g,
    category: "spacing",
    severity: "warn",
    title: "Double space",
    detail: (m) => `${m[1].length} consecutive spaces between words.`,
    suggestion: () => "Collapse to a single space.",
  },
  {
    code: "text.space-before-punct",
    re: / +([,.;:!?])/g,
    category: "spacing",
    severity: "warn",
    title: "Space before punctuation",
    detail: (m) => `Space sits before “${m[1]}”.`,
    suggestion: (m) => `Remove the space: “${m[1]}”`,
  },
  {
    code: "text.missing-space",
    re: /[a-z]([,;:])[A-Za-z]/g,
    category: "spacing",
    severity: "warn",
    title: "Missing space after punctuation",
    detail: (m) => `No space after “${m[1]}”.`,
    suggestion: (m) => `Add a space after “${m[1]}”.`,
  },
  {
    code: "text.repeated-word",
    re: /\b([A-Za-z][A-Za-z']{1,})\s+\1\b/gi,
    category: "typo",
    severity: "error",
    title: "Repeated word",
    detail: (m) => `“${m[1]}” appears twice in a row.`,
    suggestion: (m) => `Delete one “${m[1]}”.`,
  },
  {
    code: "text.placeholder",
    re: /(lorem ipsum|\bTBD\b|\bTODO\b|\bXXX+\b|\[insert[^\]]*\]|placeholder text|\bFPO\b)/gi,
    category: "placeholder",
    severity: "error",
    title: "Placeholder text left in deck",
    detail: (m) => `Found “${m[1]}”.`,
    suggestion: () => "Replace with real copy before submitting.",
  },
  {
    code: "text.doubled-punct",
    re: /([!?])\1+|(?<!\.)\.\.(?!\.)/g,
    category: "punctuation",
    severity: "warn",
    title: "Doubled punctuation",
    detail: (m) => `“${m[0]}” — likely a typo.`,
  },
  {
    code: "text.lowercase-sentence",
    re: /[.!?]\s+([a-z])/g,
    category: "capitalization",
    severity: "info",
    title: "Sentence starts lowercase",
    detail: (m) => `Sentence begins with “${m[1]}”.`,
    suggestion: (m) => `Capitalise: “${m[1].toUpperCase()}”`,
  },
];

function textChecks(slide: number, shapes: TextShape[]): Finding[] {
  const out: Finding[] = [];
  for (const sh of shapes) {
    for (const p of sh.paragraphs) {
      const text = p.text;
      for (const rule of TEXT_RULES) {
        rule.re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = rule.re.exec(text))) {
          out.push(
            mk({
              code: rule.code,
              slide,
              severity: rule.severity,
              category: rule.category,
              title: rule.title,
              detail: rule.detail(m),
              quote: excerpt(text, m.index, m[0].length),
              suggestion: rule.suggestion?.(m),
              shapeIds: [sh.id],
            }),
          );
          if (m.index === rule.re.lastIndex) rule.re.lastIndex++;
        }
      }
      const bal = unbalanced(text);
      if (bal) {
        out.push(
          mk({
            code: "text.unbalanced",
            slide,
            severity: "warn",
            category: "punctuation",
            title: "Unbalanced bracket or quote",
            detail: bal,
            quote: text.slice(0, 120),
            shapeIds: [sh.id],
          }),
        );
      }
    }
  }
  return out;
}

function unbalanced(text: string): string | null {
  const pairs: [string, string][] = [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
    ["“", "”"],
  ];
  for (const [open, close] of pairs) {
    const o = count(text, open);
    const c = count(text, close);
    if (o !== c) return `${o} “${open}” vs ${c} “${close}”.`;
  }
  if (count(text, '"') % 2 === 1) return `Odd number of straight quotes (").`;
  return null;
}

const count = (s: string, ch: string) => s.split(ch).length - 1;

function excerpt(text: string, at: number, len: number): string {
  const start = Math.max(0, at - 30);
  const end = Math.min(text.length, at + len + 30);
  return (start > 0 ? "…" : "") + text.slice(start, end).replace(/\n/g, " ⏎ ") + (end < text.length ? "…" : "");
}

// ================================================== text consistency, deck-wide

const STOP = new Set(
  "the and for with this that from you your our are was were will have has can not but all any its it's".split(" "),
);

type CaseClass = "lower" | "title" | "upper" | "mixed";

/**
 * "DESIGN" vs "Design" is a heading style choice. "HarbourFront" vs "Harbourfront"
 * is a mistake. Only the second kind has an internally-capitalised (mixed) form.
 */
function caseClass(word: string): CaseClass {
  const segs = word.split(/[-'’]/).filter((s) => /[A-Za-z]/.test(s));
  if (!segs.length) return "mixed";
  const cls = segs.map((s) => {
    if (s === s.toLowerCase()) return "lower";
    if (s === s.toUpperCase()) return "upper";
    if (s[0] === s[0].toUpperCase() && s.slice(1) === s.slice(1).toLowerCase()) return "title";
    return "mixed";
  });
  if (cls.includes("mixed")) return "mixed";
  const uniq = new Set(cls);
  if (uniq.size === 1) return cls[0] as CaseClass;
  // "Bi-weekly" — title + lower segments, still just sentence styling.
  return uniq.has("upper") ? "mixed" : "title";
}

function deckTextConsistency(deck: Deck): Finding[] {
  const out: Finding[] = [];

  const bySurface = new Map<string, Set<number>>();
  const byShape = new Map<string, string[]>();
  const surfacesForKey = new Map<string, Set<string>>();
  const surfacesForSquash = new Map<string, Set<string>>();

  let straight = 0;
  let curly = 0;

  for (const slide of deck.slides) {
    for (const sh of slide.shapes) {
      if (!isText(sh)) continue;
      for (const p of sh.paragraphs) {
        straight += count(p.text, '"') + count(p.text, "'");
        curly += count(p.text, "“") + count(p.text, "”") + count(p.text, "’");

        const words = p.text.match(/[A-Za-z][A-Za-z'’-]*/g) ?? [];
        for (let i = 0; i < words.length; i++) {
          const w = words[i];
          if (w.length < 3 || STOP.has(w.toLowerCase())) continue;
          track(bySurface, w, slide.index);
          push(byShape, w, sh.id);
          add(surfacesForKey, w.toLowerCase(), w);
          add(surfacesForSquash, squash(w), w);

          if (i + 1 < words.length) {
            const bi = `${w} ${words[i + 1]}`;
            add(surfacesForSquash, squash(bi), bi);
            track(bySurface, bi, slide.index);
            push(byShape, bi, sh.id);
          }
        }
      }
    }
  }

  // Capitalisation drift, split into real mistakes vs heading styling.
  const styling: string[] = [];
  for (const [, surfaces] of surfacesForKey) {
    if (surfaces.size < 2) continue;
    const forms = [...surfaces];
    if (new Set(forms.map((f) => f.slice(1))).size < 2) continue; // differs only in first letter → sentence case
    if (!forms.some((f) => caseClass(f) === "mixed")) {
      styling.push(forms.join(" / "));
      continue;
    }
    out.push(
      mk({
        code: "term.case-drift",
        slide: minSlide(forms, bySurface),
        severity: "warn",
        category: "consistency",
        title: `“${forms[0]}” vs “${forms.slice(1).join("” vs “")}”`,
        detail: `The same word is capitalised differently across the deck. Pick one spelling.`,
        quote: forms.join("  /  "),
        relatedSlides: allSlides(forms, bySurface),
        shapeIds: forms.flatMap((f) => byShape.get(f) ?? []),
      }),
    );
  }
  if (styling.length) {
    out.push(
      mk({
        code: "term.case-styling",
        slide: 1,
        severity: "info",
        category: "consistency",
        title: `${styling.length} term${styling.length > 1 ? "s" : ""} appear in different letter cases`,
        detail: `Usually intentional heading styling, worth a glance: ${styling.slice(0, 8).join(", ")}${styling.length > 8 ? ", …" : ""}.`,
      }),
    );
  }

  // "Back End" vs "Backend" vs "back-end".
  for (const [key, surfaces] of surfacesForSquash) {
    if (surfaces.size < 2 || key.length < 6) continue;
    const forms = [...surfaces];
    if (new Set(forms.map((f) => f.toLowerCase())).size < 2) continue; // pure case drift, handled above
    out.push(
      mk({
        code: "term.spelling-variant",
        slide: minSlide(forms, bySurface),
        severity: "warn",
        category: "consistency",
        title: `“${forms[0]}” vs “${forms.slice(1).join("” vs “")}”`,
        detail: `The same term is written more than one way. Unify it across the deck.`,
        quote: forms.join("  /  "),
        relatedSlides: allSlides(forms, bySurface),
        shapeIds: forms.flatMap((f) => byShape.get(f) ?? []),
      }),
    );
  }

  if (straight > 0 && curly > 0) {
    out.push(
      mk({
        code: "style.mixed-quotes",
        slide: 1,
        severity: "info",
        category: "consistency",
        title: "Mixed straight and curly quotes",
        detail: `${straight} straight vs ${curly} typographic. Pick one style deck-wide.`,
      }),
    );
  }

  const titleSizes = new Map<number, number[]>();
  for (const slide of deck.slides) {
    for (const sh of slide.shapes) {
      if (!isText(sh) || !sh.placeholder?.toLowerCase().includes("title")) continue;
      for (const s of sh.paragraphs.flatMap((p) => p.sizes)) push2(titleSizes, s, slide.index);
    }
  }
  if (titleSizes.size > 1) {
    const summary = [...titleSizes.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([sz, slides]) => `${sz}pt on ${slides.length} slide${slides.length > 1 ? "s" : ""}`)
      .join(", ");
    out.push(
      mk({
        code: "style.title-size",
        slide: 1,
        severity: "info",
        category: "consistency",
        title: "Title font size varies across slides",
        detail: summary,
        relatedSlides: [...new Set([...titleSizes.values()].flat())].sort((a, b) => a - b),
      }),
    );
  }

  return out;
}

const squash = (s: string) => s.toLowerCase().replace(/[\s-]/g, "");
const track = (m: Map<string, Set<number>>, k: string, v: number) =>
  (m.get(k) ?? m.set(k, new Set()).get(k)!).add(v);
const add = (m: Map<string, Set<string>>, k: string, v: string) =>
  (m.get(k) ?? m.set(k, new Set()).get(k)!).add(v);
const push = (m: Map<string, string[]>, k: string, v: string) => {
  const arr = m.get(k) ?? m.set(k, []).get(k)!;
  if (!arr.includes(v)) arr.push(v);
};
const push2 = (m: Map<number, number[]>, k: number, v: number) => {
  const arr = m.get(k) ?? m.set(k, []).get(k)!;
  if (!arr.includes(v)) arr.push(v);
};
const allSlides = (forms: string[], by: Map<string, Set<number>>) =>
  [...new Set(forms.flatMap((f) => [...(by.get(f) ?? [])]))].sort((a, b) => a - b);
const minSlide = (forms: string[], by: Map<string, Set<number>>) => allSlides(forms, by)[0] ?? 1;

// ========================================================== images, per slide

function visibleSource(pic: PicShape, natW: number, natH: number) {
  return {
    w: natW * Math.max(0, 1 - pic.crop.l - pic.crop.r),
    h: natH * Math.max(0, 1 - pic.crop.t - pic.crop.b),
  };
}

export function effectiveDpi(pic: PicShape, natW: number, natH: number) {
  const vis = visibleSource(pic, natW, natH);
  const wIn = inches(pic.rect.w);
  const hIn = inches(pic.rect.h);
  if (wIn <= 0 || hIn <= 0 || vis.w <= 0 || vis.h <= 0) return null;
  // A 90°/270° rotation swaps which source axis fills which display axis.
  const quarter = Math.abs((((pic.rot % 180) + 180) % 180) - 90) < 45;
  const dpiX = (quarter ? vis.h : vis.w) / wIn;
  const dpiY = (quarter ? vis.w : vis.h) / hIn;
  return { dpiX, dpiY, min: Math.min(dpiX, dpiY), vis, quarter };
}

function imageChecks(deck: Deck, slide: number, pics: PicShape[]): Finding[] {
  const out: Finding[] = [];
  const slideArea = deck.widthEmu * deck.heightEmu;
  const oversized: PicShape[] = [];

  for (const pic of pics) {
    const info = deck.media.get(pic.media);
    if (!info || info.format === "svg" || !info.width || !info.height) continue;

    const eff = effectiveDpi(pic, info.width, info.height);
    if (!eff) continue;

    const dpi = Math.round(eff.min);
    const target = `${Math.ceil(inches(pic.rect.w) * 150)}×${Math.ceil(inches(pic.rect.h) * 150)}px`;

    if (dpi < 96) {
      out.push(
        mk({
          code: "img.upscaled",
          slide,
          severity: "error",
          category: "resolution",
          title: `${name(pic)} will look blurry`,
          detail: `Only ${Math.round(eff.vis.w)}×${Math.round(eff.vis.h)}px of real pixels, stretched to ${dim(pic)} on the slide. That is ${dpi} DPI — below 96 the image is enlarged past its native size.`,
          suggestion: `Re-export at ≥ ${target}.`,
          shapeIds: [pic.id],
        }),
      );
    } else if (dpi < 150) {
      out.push(
        mk({
          code: "img.low-dpi",
          slide,
          severity: "warn",
          category: "resolution",
          title: `${name(pic)} is soft when printed`,
          detail: `${Math.round(eff.vis.w)}×${Math.round(eff.vis.h)}px shown at ${dim(pic)} — ${dpi} DPI. Fine on a screen, soft on paper or a projector.`,
          suggestion: `Re-export at ≥ ${target}.`,
          shapeIds: [pic.id],
        }),
      );
    }

    // Only judge distortion on images large enough for it to be visible.
    if (inches(pic.rect.w) >= 0.5 && inches(pic.rect.h) >= 0.5) {
      const srcAr = eff.vis.w / eff.vis.h;
      const dispAr = eff.quarter ? pic.rect.h / pic.rect.w : pic.rect.w / pic.rect.h;
      const dev = dispAr / srcAr - 1;
      if (Math.abs(dev) > 0.02) {
        const pct = (Math.abs(dev) * 100).toFixed(1);
        out.push(
          mk({
            code: "img.distorted",
            slide,
            severity: Math.abs(dev) > 0.05 ? "error" : "warn",
            category: "aspect",
            title: `${name(pic)} is stretched ${dev > 0 ? "wider" : "taller"} by ${pct}%`,
            detail: `Native proportions ${srcAr.toFixed(3)} vs displayed ${dispAr.toFixed(3)}. Circles, faces, and logos will look wrong.`,
            suggestion: "Hold Shift while resizing, or reset to original proportions.",
            shapeIds: [pic.id],
          }),
        );
      }
    }

    // eff.vis, not info.width: a 40px logo cropped out of a 2000px sprite sheet
    // is not a "large asset".
    if (eff.vis.w >= 1000 && (pic.rect.w * pic.rect.h) / slideArea < 0.003) oversized.push(pic);
  }

  if (oversized.length) {
    out.push(
      mk({
        code: "img.oversized",
        slide,
        severity: "info",
        category: "resolution",
        title:
          oversized.length === 1
            ? "Large asset rendered very small"
            : `${oversized.length} large assets rendered very small`,
        detail: `${oversized
          .slice(0, 4)
          .map((p) => `${name(p)} at ${dim(p)}`)
          .join(", ")}${oversized.length > 4 ? ", …" : ""}. Bloats the file; downsize the source or check for stray elements.`,
        shapeIds: oversized.map((p) => p.id),
      }),
    );
  }

  // Siblings: content-sized pictures laid out in the same row or column.
  const siblings = pics.filter((p) => (p.rect.w * p.rect.h) / slideArea >= CONTENT_AREA_FRAC);
  if (siblings.length > 1 && siblings.length <= MAX_SIBLINGS) {
    for (let i = 0; i < siblings.length; i++) {
      for (let j = i + 1; j < siblings.length; j++) {
        const a = siblings[i];
        const b = siblings[j];
        const row = sharesRow(a.rect, b.rect);
        const col = sharesColumn(a.rect, b.rect);
        if (!row && !col) continue;

        const dims = (["width", "height"] as const).filter((d) =>
          nearMiss(d === "width" ? a.rect.w : a.rect.h, d === "width" ? b.rect.w : b.rect.h),
        );
        if (dims.length) {
          const worst = dims
            .map((d) => {
              const av = d === "width" ? a.rect.w : a.rect.h;
              const bv = d === "width" ? b.rect.w : b.rect.h;
              return { d, off: Math.abs(av - bv), av, bv };
            })
            .sort((x, y) => y.off - x.off)[0];
          out.push(
            mk({
              code: "img.sibling-size",
              slide,
              severity: "warn",
              category: "consistency",
              title: `Two images side by side are ${pxOf(worst.off)}px apart in ${worst.d}`,
              detail: `${name(a)} is ${pxOf(worst.av)}px and ${name(b)} is ${pxOf(worst.bv)}px. They sit in the same ${row ? "row" : "column"}, so they were probably meant to match.`,
              suggestion: `Set both to ${pxOf(Math.max(worst.av, worst.bv))}px ${worst.d}.`,
              shapeIds: [a.id, b.id],
            }),
          );
        }

        // Items in a row should share a top edge; items in a column, a left edge.
        const edge = row ? ("y" as const) : ("x" as const);
        const d = Math.abs(a.rect[edge] - b.rect[edge]);
        if (d > 0.01 * EMU_PER_INCH && d < 0.045 * EMU_PER_INCH) {
          out.push(
            mk({
              code: "img.sibling-align",
              slide,
              severity: "warn",
              category: "alignment",
              title: `Two images are ${pxOf(d)}px out of alignment`,
              detail: `${name(a)} and ${name(b)} should share the same ${edge === "x" ? "left" : "top"} edge but differ by ${pxOf(d)}px.`,
              suggestion: `Align their ${edge === "x" ? "left" : "top"} edges.`,
              shapeIds: [a.id, b.id],
            }),
          );
        }
      }
    }
  }

  return out;
}

const span = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const sharesRow = (a: Rect, b: Rect) => span(a.y, a.y + a.h, b.y, b.y + b.h) >= 0.5 * Math.min(a.h, b.h);
const sharesColumn = (a: Rect, b: Rect) => span(a.x, a.x + a.w, b.x, b.x + b.w) >= 0.5 * Math.min(a.w, b.w);

function nearMiss(a: number, b: number) {
  if (a === 0 || b === 0) return false;
  const rel = Math.abs(a - b) / Math.max(a, b);
  return rel > 0.005 && rel < 0.08;
}

// ================================================ images consistency, deck-wide

function deckImageConsistency(deck: Deck): Finding[] {
  const out: Finding[] = [];

  // Key on crop as well as file: two crops of one sprite sheet are two images.
  // A deliberate thumbnail-vs-hero pair differs hugely; a mistake differs slightly.
  const cropKey = (p: PicShape) => [p.crop.l, p.crop.t, p.crop.r, p.crop.b].map((v) => v.toFixed(3)).join(",");
  const usage = new Map<string, { slide: number; w: number; id: string }[]>();
  for (const slide of deck.slides) {
    for (const sh of slide.shapes) {
      if (!isPic(sh)) continue;
      const key = `${sh.media}|${cropKey(sh)}`;
      const arr = usage.get(key) ?? usage.set(key, []).get(key)!;
      arr.push({ slide: slide.index, w: sh.rect.w, id: sh.id });
    }
  }
  for (const [key, uses] of usage) {
    if (uses.length < 2) continue;
    const min = Math.min(...uses.map((u) => u.w));
    const max = Math.max(...uses.map((u) => u.w));
    if (max <= 0 || !nearMiss(min, max)) continue;
    const slides = [...new Set(uses.map((u) => u.slide))];
    const file = key.split("|")[0].split("/").pop();
    out.push(
      mk({
        code: "img.same-nudged",
        slide: uses[0].slide,
        severity: "warn",
        category: "consistency",
        title: `The same image is ${pxOf(max - min)}px wider on some slides`,
        detail: `${file} is placed ${uses.length} times at widths ${pxOf(min)}px–${pxOf(max)}px. Snap them all to one size.`,
        suggestion: `Set every copy to ${pxOf(max)}px wide.`,
        relatedSlides: slides,
        shapeIds: uses.map((u) => u.id),
      }),
    );
  }

  // The hero visual on each slide should keep a stable width.
  const heroes: { slide: number; w: number; id: string }[] = [];
  for (const slide of deck.slides) {
    const pics = slide.shapes.filter(isPic);
    if (!pics.length) continue;
    const hero = pics.reduce((a, b) => (a.rect.w * a.rect.h >= b.rect.w * b.rect.h ? a : b));
    if (hero.rect.w * hero.rect.h < 0.06 * deck.widthEmu * deck.heightEmu) continue;
    heroes.push({ slide: slide.index, w: hero.rect.w, id: hero.id });
  }
  if (heroes.length >= 4) {
    const bucket = (w: number) => Math.round(w / (0.05 * EMU_PER_INCH));
    const counts = new Map<number, number>();
    for (const h of heroes) counts.set(bucket(h.w), (counts.get(bucket(h.w)) ?? 0) + 1);
    const [modeBucket, modeCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const modeW = modeBucket * 0.05 * EMU_PER_INCH;
    if (modeCount >= Math.max(3, heroes.length * 0.4)) {
      const odd = heroes.filter((h) => {
        const rel = Math.abs(h.w - modeW) / modeW;
        return rel > 0.04 && rel < 0.3;
      });
      if (odd.length) {
        out.push(
          mk({
            code: "img.hero-width",
            slide: odd[0].slide,
            severity: "info",
            category: "consistency",
            title: `Main visual is a different width on ${odd.length} slide${odd.length > 1 ? "s" : ""}`,
            detail: `${modeCount} slides use ~${pxOf(modeW)}px; slides ${odd.map((o) => o.slide).join(", ")} use ${odd.map((o) => `${pxOf(o.w)}px`).join(", ")}.`,
            suggestion: `Set them to ${pxOf(modeW)}px wide.`,
            relatedSlides: odd.map((o) => o.slide),
            shapeIds: odd.map((o) => o.id),
          }),
        );
      }
    }
  }

  return out;
}

// ============================================================ duplicate slides

/**
 * Two slides are near-duplicates when they share most of their content images
 * AND most of their body text. Comparing images matters: a repeated footer/logo
 * alone is a template, not a duplicate — the *content* pictures have to match too.
 */
function duplicateSlides(deck: Deck): Finding[] {
  const slideArea = deck.widthEmu * deck.heightEmu;

  // A picture big enough to be content, keyed by file + crop (a sprite-sheet crop
  // is its own image). The FXMedia logo repeats everywhere, so weight by content.
  const fingerprint = deck.slides.map((slide) => {
    const media = new Set<string>();
    for (const sh of slide.shapes) {
      if (sh.kind !== "pic") continue;
      if ((sh.rect.w * sh.rect.h) / slideArea < 0.02) continue; // skip tiny logos/icons
      const crop = [sh.crop.l, sh.crop.t, sh.crop.r, sh.crop.b].map((v) => v.toFixed(3)).join(",");
      media.add(`${sh.media}|${crop}`);
    }
    const words = new Set<string>();
    for (const sh of slide.shapes) {
      if (sh.kind !== "text") continue;
      for (const p of sh.paragraphs) for (const w of p.text.toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) ?? []) words.add(w);
    }
    return { index: slide.index, media, words };
  });

  const jaccard = <T,>(a: Set<T>, b: Set<T>): number => {
    if (a.size === 0 && b.size === 0) return 1;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
  };

  // Union-find so 3+ identical slides collapse into one cluster.
  const parent = fingerprint.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));

  for (let i = 0; i < fingerprint.length; i++) {
    for (let j = i + 1; j < fingerprint.length; j++) {
      const a = fingerprint[i];
      const b = fingerprint[j];
      // A slide needs some content to be a meaningful duplicate.
      if (a.media.size === 0 && a.words.size < 4) continue;

      const mediaSim = a.media.size || b.media.size ? jaccard(a.media, b.media) : 1;
      const textSim = jaccard(a.words, b.words);
      const dup =
        (a.media.size >= 1 && mediaSim >= 0.7 && textSim >= 0.5) || // same photos + most text
        (a.media.size === 0 && textSim >= 0.9); // text-only slides that are all but identical
      if (dup) parent[find(i)] = find(j);
    }
  }

  const clusters = new Map<number, number[]>();
  for (let i = 0; i < fingerprint.length; i++) {
    const root = find(i);
    (clusters.get(root) ?? clusters.set(root, []).get(root)!).push(fingerprint[i].index);
  }

  const out: Finding[] = [];
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    const sorted = [...members].sort((a, b) => a - b);
    const rest = sorted.slice(1);
    out.push(
      mk({
        code: "slide.duplicate",
        slide: sorted[0],
        severity: "warn",
        category: "consistency",
        title:
          members.length === 2
            ? `Slide ${sorted[1]} looks like a duplicate of slide ${sorted[0]}`
            : `${members.length} near-identical slides (${sorted.join(", ")})`,
        detail: `Slides ${sorted.join(", ")} share the same images and almost the same text. Keep one, or make sure each is meant to be there.`,
        relatedSlides: rest,
      }),
    );
  }
  return out;
}

// ================================================================== geometry

function geometryChecks(deck: Deck): Finding[] {
  const out: Finding[] = [];
  const tol = 0.05 * EMU_PER_INCH;
  const { widthEmu: W, heightEmu: H } = deck;

  // Elements parked off-canvas are usually one template artefact repeated on
  // every slide. Report the artefact once, not once per slide.
  const parked = new Map<string, { slides: number[]; ids: string[]; sample: string }>();

  for (const slide of deck.slides) {
    for (const sh of slide.shapes) {
      const { x, y, w, h } = sh.rect;
      if (w <= 0 || h <= 0) continue;

      if (x + w <= 0 || y + h <= 0 || x >= W || y >= H) {
        const sample = sh.kind === "text" ? sh.paragraphs[0]?.text.slice(0, 50) ?? sh.name : name(sh);
        const key = `${sh.kind}:${sample}`;
        const e = parked.get(key) ?? parked.set(key, { slides: [], ids: [], sample }).get(key)!;
        e.slides.push(slide.index);
        e.ids.push(sh.id);
        continue;
      }

      const overR = x + w - W;
      const overB = y + h - H;
      // Only real text can be "cut off". Decorative rectangles (banners, footer
      // bars) routinely bleed past the edge by design — don't flag those.
      const hasText = sh.kind === "text" && sh.paragraphs.some((p) => p.text.trim());
      if (hasText && (overR > tol || overB > tol || x < -tol || y < -tol)) {
        const dirs = [
          overR > tol ? `${inches(overR).toFixed(2)}in past the right edge` : "",
          overB > tol ? `${inches(overB).toFixed(2)}in past the bottom` : "",
          x < -tol ? `${inches(-x).toFixed(2)}in past the left edge` : "",
          y < -tol ? `${inches(-y).toFixed(2)}in above the top` : "",
        ].filter(Boolean);
        out.push(
          mk({
            code: "geo.text-overflow",
            slide: slide.index,
            severity: "warn",
            category: "geometry",
            title: "A text box runs off the slide",
            detail: `“${sh.paragraphs[0]?.text.slice(0, 60) ?? sh.name}” extends ${dirs.join(" and ")}. Text may be cut off.`,
            shapeIds: [sh.id],
          }),
        );
      } else if (sh.kind === "pic") {
        // Clipped *area*, not the sum of per-axis overflow: an image bleeding off
        // a corner is normal, one that is 80% off the canvas is a leftover.
        const visibleArea = span(x, x + w, 0, W) * span(y, y + h, 0, H);
        const hiddenFrac = 1 - visibleArea / (w * h);
        if (hiddenFrac > 0.7) {
          out.push(
            mk({
              code: "geo.pic-offslide",
              slide: slide.index,
              severity: "warn",
              category: "geometry",
              title: `${Math.round(hiddenFrac * 100)}% of an image is off the slide`,
              detail: `${name(sh)} is mostly outside the canvas and never renders — leftover element?`,
              shapeIds: [sh.id],
            }),
          );
        }
      }
    }
  }

  for (const [, e] of parked) {
    out.push(
      mk({
        code: "geo.parked",
        slide: e.slides[0],
        severity: "info",
        category: "geometry",
        title:
          e.slides.length > 1
            ? `A hidden element sits off-canvas on ${e.slides.length} slides`
            : "A hidden element sits off-canvas",
        detail: `“${e.sample}” is entirely outside the slide area, so it never renders. Delete it or move it back.`,
        relatedSlides: e.slides,
        shapeIds: e.ids,
      }),
    );
  }

  return out;
}

// ==================================================================== display

const pxOf = (emu: number) => Math.round((emu / EMU_PER_INCH) * 96);
const dim = (p: PicShape) => `${pxOf(p.rect.w)}×${pxOf(p.rect.h)}px`;

/** Prefer the alt-text/title an author actually wrote over "Google Shape;134;p16". */
function name(s: Shape): string {
  if (s.kind !== "pic") return s.name || "Shape";
  const raw = s.descr || s.name || "";
  const clean = raw.split("\n")[0].trim();
  const generic = /^(Google Shape|Picture|Image|Shape)\b/i.test(clean) || !clean;
  return generic ? (s.media.split("/").pop() ?? "Image") : clean.length > 48 ? `${clean.slice(0, 46)}…` : clean;
}
