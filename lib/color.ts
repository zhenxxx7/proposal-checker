import type { Fill, Line } from "./types";

const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";

/** dk1/lt1/… → hex, parsed once from theme1.xml. */
export type Scheme = Map<string, string>;

/** The default clrMap most decks use: placeholder names → theme scheme names. */
const CLR_MAP: Record<string, string> = {
  bg1: "lt1",
  tx1: "dk1",
  bg2: "lt2",
  tx2: "dk2",
  dk1: "dk1",
  lt1: "lt1",
  dk2: "dk2",
  lt2: "lt2",
  accent1: "accent1",
  accent2: "accent2",
  accent3: "accent3",
  accent4: "accent4",
  accent5: "accent5",
  accent6: "accent6",
  hlink: "hlink",
  folHlink: "folHlink",
};

export function parseScheme(themeDoc: Document | null): Scheme {
  const scheme: Scheme = new Map();
  const clrScheme = themeDoc?.getElementsByTagNameNS(NS_A, "clrScheme")[0];
  if (!clrScheme) return scheme;
  for (const node of Array.from(clrScheme.childNodes)) {
    if (node.nodeType !== 1) continue;
    const el = node as Element;
    const hex = colorFromContainer(el, scheme);
    if (hex) scheme.set(el.localName, hex);
  }
  return scheme;
}

/** Major (headings) and minor (body) latin faces from the theme's fontScheme. */
export interface ThemeFonts {
  major?: string;
  minor?: string;
}

export function parseFontScheme(themeDoc: Document | null): ThemeFonts {
  const out: ThemeFonts = {};
  const fs = themeDoc?.getElementsByTagNameNS(NS_A, "fontScheme")[0];
  if (!fs) return out;
  for (const [tag, key] of [["majorFont", "major"], ["minorFont", "minor"]] as const) {
    const latin = fs.getElementsByTagNameNS(NS_A, tag)[0]?.getElementsByTagNameNS(NS_A, "latin")[0];
    const face = latin?.getAttribute("typeface");
    if (face) out[key] = face;
  }
  return out;
}

/**
 * A slide master's <p:clrMap> remaps placeholder names (bg1/tx1/bg2/tx2) onto
 * scheme slots. Bake the mapping into the scheme so lookups stay a single get.
 */
export function applyClrMap(scheme: Scheme, clrMapEl: Element | null): Scheme {
  const out = new Map(scheme);
  const pairs: [string, string][] = clrMapEl
    ? Array.from(clrMapEl.attributes).map((a) => [a.localName, a.value])
    : Object.entries(CLR_MAP);
  for (const [from, to] of pairs) {
    const hex = scheme.get(to);
    if (hex) out.set(from, hex);
  }
  return out;
}

/**
 * Resolve the colour inside a container element (solidFill, gs, ln, etc.) to a
 * CSS string. Handles srgbClr / schemeClr / sysClr / prstClr and the common
 * modifiers (alpha, lumMod, lumOff, shade, tint).
 */
export function resolveColor(container: Element | null, scheme: Scheme): string | null {
  if (!container) return null;
  return colorFromContainer(container, scheme);
}

export function resolveFill(spPr: Element | null, scheme: Scheme): Fill | undefined {
  if (!spPr) return undefined;

  // noFill wins if it is a direct child.
  for (const c of directChildren(spPr)) {
    if (c.localName === "noFill") return undefined;
    const fill = resolveFillElement(c, scheme);
    if (fill) return fill;
  }
  return undefined;
}

/** Resolve one DrawingML fill node, including theme style-matrix entries. */
export function resolveFillElement(fill: Element, scheme: Scheme): Fill | undefined {
  if (fill.localName === "solidFill") {
    const color = colorFromContainer(fill, scheme);
    return color ? { type: "solid", color } : undefined;
  }
  if (fill.localName === "gradFill") {
    const css = gradientCss(fill, scheme);
    return css ? { type: "gradient", css } : undefined;
  }
  if (fill.localName === "pattFill") {
    // CSS has no direct equivalent for every DrawingML preset pattern. The
    // background colour covers most pixels and is a faithful non-transparent
    // fallback; use the foreground when the background is absent.
    const background = directChildren(fill).find((child) => child.localName === "bgClr");
    const foreground = directChildren(fill).find((child) => child.localName === "fgClr");
    const color = colorFromContainer(background ?? foreground ?? fill, scheme);
    return color ? { type: "solid", color } : undefined;
  }
  return undefined;
}

/** 1..999 index fillStyleLst; 1001+ index bgFillStyleLst. */
export function themeFillElement(themeDoc: Document | null, index: number): Element | null {
  if (!themeDoc || index <= 0) return null;
  const background = index >= 1001;
  const listName = background ? "bgFillStyleLst" : "fillStyleLst";
  const offset = background ? index - 1001 : index - 1;
  const list = themeDoc.getElementsByTagNameNS(NS_A, listName)[0];
  if (!list || offset < 0) return null;
  return directChildren(list)[offset] ?? null;
}

export function resolveLine(spPr: Element | null, scheme: Scheme): Line | undefined {
  const ln = spPr ? directChildren(spPr).find((c) => c.localName === "ln") : undefined;
  if (!ln) return undefined;
  if (directChildren(ln).some((c) => c.localName === "noFill")) return undefined;
  const fill = directChildren(ln).find((c) => c.localName === "solidFill");
  const color = fill ? colorFromContainer(fill, scheme) : null;
  if (!color) return undefined;
  const width = Number(ln.getAttribute("w")) || 9525; // EMU; 9525 ≈ 1px
  const dash = !!directChildren(ln).find((c) => c.localName === "prstDash");
  return { color, width, dash };
}

// ---------------------------------------------------------------- background

export function resolveBackground(slideDoc: Document, scheme: Scheme): Fill | undefined {
  const bg = slideDoc.getElementsByTagNameNS("http://schemas.openxmlformats.org/presentationml/2006/main", "bg")[0];
  if (!bg) return undefined;
  const bgPr = bg.getElementsByTagNameNS(NS_A, "gradFill")[0]
    ? bg
    : bg.getElementsByTagNameNS("http://schemas.openxmlformats.org/presentationml/2006/main", "bgPr")[0] ?? bg;

  const grad = bgPr.getElementsByTagNameNS(NS_A, "gradFill")[0];
  if (grad) {
    const css = gradientCss(grad, scheme);
    if (css) return { type: "gradient", css };
  }
  const solid = bgPr.getElementsByTagNameNS(NS_A, "solidFill")[0];
  if (solid) {
    const color = colorFromContainer(solid, scheme);
    if (color) return { type: "solid", color };
  }
  // Theme-backed backgrounds commonly use <p:bgRef> instead of embedding a
  // fill. Its colour is still a reliable preview fallback even when the full
  // theme style matrix is not represented in CSS.
  const bgRef = bg.getElementsByTagNameNS(
    "http://schemas.openxmlformats.org/presentationml/2006/main",
    "bgRef",
  )[0];
  const refColor = bgRef ? colorFromContainer(bgRef, scheme) : null;
  if (refColor) return { type: "solid", color: refColor };
  return undefined;
}

// ---------------------------------------------------------------- internals

/** Find the first colour child of a container and apply its modifiers. */
function colorFromContainer(container: Element, scheme: Scheme): string | null {
  for (const c of directChildren(container)) {
    switch (c.localName) {
      case "srgbClr":
        return applyMods(c.getAttribute("val") ?? "000000", c);
      case "sysClr":
        return applyMods(c.getAttribute("lastClr") ?? "000000", c);
      case "schemeClr": {
        const raw = c.getAttribute("val") ?? "";
        // Direct hit first — applyClrMap bakes bg1/tx1/… into the scheme.
        const hex = scheme.get(raw) ?? scheme.get(CLR_MAP[raw] ?? "");
        return hex ? applyMods(hex, c) : null;
      }
      case "prstClr": {
        const hex = PRESET[c.getAttribute("val") ?? ""] ?? null;
        return hex ? applyMods(hex, c) : null;
      }
    }
  }
  return null;
}

function gradientCss(gradFill: Element, scheme: Scheme): string | null {
  const gsLst = gradFill.getElementsByTagNameNS(NS_A, "gsLst")[0];
  if (!gsLst) return null;
  const stops: string[] = [];
  for (const gs of directChildren(gsLst)) {
    if (gs.localName !== "gs") continue;
    const color = colorFromContainer(gs, scheme);
    if (!color) continue;
    const pos = Number(gs.getAttribute("pos")) / 1000; // 0–100000 → percent
    stops.push(`${color} ${Number.isFinite(pos) ? pos : 0}%`);
  }
  if (stops.length < 2) return stops.length === 1 ? stops[0].split(" ")[0] : null;

  const lin = gradFill.getElementsByTagNameNS(NS_A, "lin")[0];
  // OOXML angle: 60000ths of a degree, clockwise from 3 o'clock.
  // CSS: degrees clockwise from 12 o'clock. Convert: css = ooxml + 90.
  const angleDeg = lin ? Number(lin.getAttribute("ang")) / 60000 : 90;
  const css = ((Number.isFinite(angleDeg) ? angleDeg : 0) + 90) % 360;
  return `linear-gradient(${css}deg, ${stops.join(", ")})`;
}

/** Apply alpha / lumMod / lumOff / shade / tint modifiers to a base hex. */
function applyMods(hex: string, el: Element): string {
  let { r, g, b } = hexToRgb(hex);
  let alpha = 1;

  for (const m of directChildren(el)) {
    const val = Number(m.getAttribute("val")) / 100000; // most mods are 0–100000
    if (!Number.isFinite(val)) continue;
    switch (m.localName) {
      case "alpha":
        alpha = val;
        break;
      case "lumMod":
        [r, g, b] = [r * val, g * val, b * val];
        break;
      case "lumOff":
        [r, g, b] = [r + 255 * val, g + 255 * val, b + 255 * val];
        break;
      case "shade":
        [r, g, b] = [r * val, g * val, b * val];
        break;
      case "tint":
        [r, g, b] = [r * val + 255 * (1 - val), g * val + 255 * (1 - val), b * val + 255 * (1 - val)];
        break;
    }
  }

  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  if (alpha < 1) return `rgba(${clamp(r)}, ${clamp(g)}, ${clamp(b)}, ${alpha.toFixed(3)})`;
  return `#${[r, g, b].map((n) => clamp(n).toString(16).padStart(2, "0")).join("")}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "").padStart(6, "0").slice(0, 6);
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

function directChildren(el: Element): Element[] {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) out.push(n as Element);
  return out;
}

/** The handful of named colours decks actually use. */
const PRESET: Record<string, string> = {
  black: "000000",
  white: "FFFFFF",
  red: "FF0000",
  green: "008000",
  blue: "0000FF",
  yellow: "FFFF00",
  gray: "808080",
  grey: "808080",
  darkGray: "A9A9A9",
  lightGray: "D3D3D3",
  orange: "FFA500",
  purple: "800080",
};
