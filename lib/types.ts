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

export interface Finding {
  id: string;
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

export interface Para {
  text: string;
  /** run font sizes in points */
  sizes: number[];
}

export interface TextShape {
  kind: "text";
  id: string;
  name: string;
  rect: Rect;
  paragraphs: Para[];
  placeholder?: string;
}

export type Shape = PicShape | TextShape;

export interface Slide {
  index: number;
  shapes: Shape[];
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
