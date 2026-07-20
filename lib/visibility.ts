import type { Shape } from "./types";

/** True when at least part of a shape can render inside the slide canvas. */
export function isVisibleOnSlide(shape: Shape, widthEmu: number, heightEmu: number): boolean {
  const { x, y, w, h } = shape.rect;
  return w > 0 && h > 0 && x < widthEmu && y < heightEmu && x + w > 0 && y + h > 0;
}
