"use client";

import { EMU_PER_PT, type Deck, type Slide } from "@/lib/types";

interface Props {
  deck: Deck;
  slide: Slide;
  urls: Map<string, string>;
  highlight: Set<string>;
  onPick?: (shapeId: string) => void;
}

/**
 * Approximate reconstruction of the slide from the OOXML geometry — enough to
 * point at the offending shape. Not a renderer: no fills, effects, or fonts.
 */
export function SlidePreview({ deck, slide, urls, highlight, onPick }: Props) {
  const { widthEmu: W, heightEmu: H } = deck;
  const pct = (v: number, total: number) => `${(v / total) * 100}%`;

  return (
    <div
      className="relative w-full overflow-hidden rounded-lg border border-neutral-300 bg-white shadow-sm dark:border-neutral-700"
      style={{ aspectRatio: `${W} / ${H}`, containerType: "inline-size" }}
    >
      {slide.shapes.map((sh) => {
        const on = highlight.has(sh.id);
        const box = {
          left: pct(sh.rect.x, W),
          top: pct(sh.rect.y, H),
          width: pct(sh.rect.w, W),
          height: pct(sh.rect.h, H),
        };

        if (sh.kind === "pic") {
          const url = urls.get(sh.media);
          const fw = Math.max(0.001, 1 - sh.crop.l - sh.crop.r);
          const fh = Math.max(0.001, 1 - sh.crop.t - sh.crop.b);
          return (
            <div
              key={sh.id}
              onClick={() => onPick?.(sh.id)}
              className={`absolute overflow-hidden ${on ? "z-20 outline outline-[3px] outline-rose-500" : ""}`}
              style={box}
              title={sh.descr || sh.name}
            >
              {url && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={url}
                  alt=""
                  className="absolute max-w-none"
                  style={{
                    width: `${100 / fw}%`,
                    height: `${100 / fh}%`,
                    left: `${(-100 * sh.crop.l) / fw}%`,
                    top: `${(-100 * sh.crop.t) / fh}%`,
                    transform: `rotate(${sh.rot}deg) scale(${sh.flipH ? -1 : 1}, ${sh.flipV ? -1 : 1})`,
                  }}
                />
              )}
            </div>
          );
        }

        const pt = sh.paragraphs.flatMap((p) => p.sizes)[0] ?? 14;
        return (
          <div
            key={sh.id}
            onClick={() => onPick?.(sh.id)}
            className={`absolute overflow-hidden leading-tight text-neutral-900 ${
              on ? "z-20 bg-rose-500/10 outline outline-[3px] outline-rose-500" : ""
            }`}
            style={{ ...box, fontSize: `${((pt * EMU_PER_PT) / W) * 100}cqw` }}
          >
            {sh.paragraphs.map((p, i) => (
              <p key={i} className="whitespace-pre-wrap">
                {p.text}
              </p>
            ))}
          </div>
        );
      })}
    </div>
  );
}
