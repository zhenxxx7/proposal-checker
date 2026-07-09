export const EMU_PER_INCH = 914400;
export const EMU_PER_PT = 12700;

export type Severity = "error" | "warn" | "info";

export type Category =
  | "typo"
  | "grammar"
  | "spacing"
  | "punctuation"
  | "capitalization"
  | "consistency"
  | "placeholder"
  | "resolution"
  | "aspect"
  | "alignment"
  | "geometry"
  | "image-text";

export type Source = "rule" | "ai-text" | "ai-image";

/** Stable identifier for the rule that fired. Findings are grouped by this. */
export type Code =
  | "text.repeated-word"
  | "text.placeholder"
  | "text.double-space"
  | "text.space-before-punct"
  | "text.missing-space"
  | "text.doubled-punct"
  | "text.lowercase-sentence"
  | "text.unbalanced"
  | "term.case-drift"
  | "term.case-styling"
  | "term.spelling-variant"
  | "style.mixed-quotes"
  | "style.title-size"
  | "style.font-drift"
  | "text.low-contrast"
  | "img.upscaled"
  | "img.low-dpi"
  | "img.distorted"
  | "img.oversized"
  | "img.sibling-size"
  | "img.sibling-align"
  | "img.same-nudged"
  | "img.hero-width"
  | "geo.text-overflow"
  | "geo.pic-offslide"
  | "geo.parked"
  | "slide.duplicate"
  | "ai.text"
  | "ai.image";

export interface Finding {
  id: string;
  code: Code;
  /** 1-based slide number as seen in PowerPoint */
  slide: number;
  severity: Severity;
  category: Category;
  source: Source;
  title: string;
  detail: string;
  /** exact offending text, when applicable */
  quote?: string;
  suggestion?: string;
  /** shape id(s) to highlight on the slide preview */
  shapeIds?: string[];
  /** other slides involved (consistency findings) */
  relatedSlides?: number[];
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Crop {
  l: number;
  t: number;
  r: number;
  b: number;
}

/** A resolved, CSS-ready fill. Theme colors and modifiers are baked in at parse time. */
export type Fill =
  | { type: "solid"; color: string }
  | { type: "gradient"; css: string };

export interface Line {
  color: string;
  /** width in EMU */
  width: number;
  dash: boolean;
}

export interface PicShape {
  kind: "pic";
  id: string;
  name: string;
  descr?: string;
  rect: Rect;
  rot: number;
  flipH: boolean;
  flipV: boolean;
  media: string;
  crop: Crop;
}

export type Align = "left" | "center" | "right" | "justify";
export type Anchor = "top" | "center" | "bottom";

/** One styled run of text. Theme font references are resolved at parse time. */
export interface Run {
  text: string;
  /** points */
  size?: number;
  /** CSS colour */
  color?: string;
  font?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface Para {
  /** concatenated run text — what the checks and the AI pass read */
  text: string;
  /** run font sizes in points */
  sizes: number[];
  runs: Run[];
  align?: Align;
}

export interface TextShape {
  kind: "text";
  id: string;
  name: string;
  rect: Rect;
  rot: number;
  paragraphs: Para[];
  placeholder?: string;
  fill?: Fill;
  line?: Line;
  anchor?: Anchor;
}

export type Shape = PicShape | TextShape;

export interface Slide {
  index: number;
  shapes: Shape[];
  background?: Fill;
}

export type ImageFormat = "png" | "jpg" | "gif" | "webp" | "svg" | "unknown";

export interface MediaInfo {
  path: string;
  bytes: number;
  width: number;
  height: number;
  format: ImageFormat;
  mediaType: string;
}

export interface Deck {
  widthEmu: number;
  heightEmu: number;
  slides: Slide[];
  media: Map<string, MediaInfo>;
  blobs: Map<string, Blob>;
}

export const inches = (emu: number) => emu / EMU_PER_INCH;
export const px96 = (emu: number) => (emu / EMU_PER_INCH) * 96;
