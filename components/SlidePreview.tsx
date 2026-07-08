"use client";

import { EMU_PER_INCH, EMU_PER_PT, type Deck, type Fill, type Slide } from "@/lib/types";

interface Props {
  deck: Deck;
  slide: Slide;
  urls: Map<string, string>;
  highlight?: Set<string>;
  /** thumb drops icon-sized pictures so a 120-logo wall stays cheap to render */
  variant?: "full" | "thumb";
}

const fillCss = (f?: Fill): string | undefined =>
  f?.type === "solid" ? f.color : f?.type === "gradient" ? f.css : undefined;

/**
 * Approximate reconstruction of the slide from the OOXML geometry: background,
 * shape fills, borders, text colour and alignment. Not a full renderer — no
 * effects, shadows, theme fonts, or text autofit.
 */
export function SlidePreview({ deck, slide, urls, highlight, variant = "full" }: Props) {
  const { widthEmu: W, heightEmu: H } = deck;
  const thumb = variant === "thumb";
  const pct = (v: number, total: number) => `${(v / total) * 100}%`;
  const bg = fillCss(slide.background) ?? "#ffffff";

  const shapes = thumb
    ? slide.shapes.filter((s) => (s.rect.w * s.rect.h) / (W * H) >= 0.005)
    : slide.shapes;

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      style={{ aspectRatio: `${W} / ${H}`, containerType: "inline-size", background: bg }}
    >
      {shapes.map((sh) => {
        const on = !thumb && highlight?.has(sh.id);
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
              className={`absolute overflow-hidden ${on ? "z-20 outline outline-[3px] outline-rose-500" : ""}`}
              style={box}
              title={sh.descr || sh.name}
            >
              {url && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={url}
                  alt=""
                  loading="lazy"
                  decoding="async"
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
        const justify =
          sh.anchor === "center" ? "center" : sh.anchor === "bottom" ? "flex-end" : "flex-start";

        return (
          <div
            key={sh.id}
            className={`absolute flex flex-col overflow-hidden leading-tight ${
              on ? "z-20 outline outline-[3px] outline-rose-500" : ""
            }`}
            style={{
              ...box,
              justifyContent: justify,
              background: fillCss(sh.fill),
              border: sh.line ? `${Math.max(1, sh.line.width / EMU_PER_INCH * 96)}px ${sh.line.dash ? "dashed" : "solid"} ${sh.line.color}` : undefined,
              borderRadius: sh.line || sh.fill ? "2cqw" : undefined,
              transform: sh.rot ? `rotate(${sh.rot}deg)` : undefined,
              padding: sh.fill || sh.line ? "1cqw 1.5cqw" : undefined,
              fontSize: `${((pt * EMU_PER_PT) / W) * 100}cqw`,
            }}
          >
            {sh.paragraphs.map((p, i) => (
              <p
                key={i}
                className="whitespace-pre-wrap"
                style={{
                  color: p.color ?? "#111827",
                  textAlign: p.align,
                  fontWeight: p.bold ? 700 : undefined,
                }}
              >
                {p.text}
              </p>
            ))}
          </div>
        );
      })}
    </div>
  );
}
