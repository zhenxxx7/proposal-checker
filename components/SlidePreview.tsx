"use client";

import { normalizeFont } from "@/lib/fonts";
import { EMU_PER_INCH, EMU_PER_PT, type Deck, type Fill, type Slide, type TextShape } from "@/lib/types";

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

/** Approximate CSS clip-paths for the preset shapes decks actually use. */
const CLIP: Record<string, string> = {
  triangle: "polygon(50% 0, 100% 100%, 0 100%)",
  rtTriangle: "polygon(0 0, 0 100%, 100% 100%)",
  diamond: "polygon(50% 0, 100% 50%, 50% 100%, 0 50%)",
  rightArrow: "polygon(0 25%, 60% 25%, 60% 0, 100% 50%, 60% 100%, 60% 75%, 0 75%)",
  leftArrow: "polygon(100% 25%, 40% 25%, 40% 0, 0 50%, 40% 100%, 40% 75%, 100% 75%)",
  downArrow: "polygon(25% 0, 75% 0, 75% 60%, 100% 60%, 50% 100%, 0 60%, 25% 60%)",
  upArrow: "polygon(25% 100%, 75% 100%, 75% 40%, 100% 40%, 50% 0, 0 40%, 25% 40%)",
  chevron: "polygon(0 0, 75% 0, 100% 50%, 75% 100%, 0 100%, 25% 50%)",
  hexagon: "polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)",
  parallelogram: "polygon(20% 0, 100% 0, 80% 100%, 0 100%)",
};

/**
 * Reconstruction of the slide from the OOXML: background, preset shape
 * geometry, fills, borders, connector lines, per-run text styling, bullets,
 * insets, and line spacing — resolved through the layout/master/theme chain.
 * Still not a full renderer: no shadows/effects, WordArt, tables, or autofit.
 */
export function SlidePreview({ deck, slide, urls, highlight, variant = "full" }: Props) {
  const { widthEmu: W, heightEmu: H } = deck;
  const thumb = variant === "thumb";
  const pct = (v: number, total: number) => `${(v / total) * 100}%`;
  const cqw = (emu: number) => `${(emu / W) * 100}cqw`;
  const bg = fillCss(slide.background) ?? "#ffffff";

  // Presentation apps paint master and layout shapes before the slide itself.
  // Keep that order here while findings still point only at slide-owned shapes.
  const paintedShapes = [...(slide.backgroundShapes ?? []), ...slide.shapes];
  const shapes = thumb
    ? paintedShapes.filter((s) => s.kind === "cxn" || (s.rect.w * s.rect.h) / (W * H) >= 0.005)
    : paintedShapes;

  return (
    <div
      className="relative h-full w-full overflow-hidden"
      style={{ aspectRatio: `${W} / ${H}`, containerType: "inline-size", background: bg }}
    >
      {shapes.map((sh) => {
        const box = {
          left: pct(sh.rect.x, W),
          top: pct(sh.rect.y, H),
          width: pct(sh.rect.w, W),
          height: pct(sh.rect.h, H),
        };

        if (sh.kind === "cxn") {
          // A straight connector runs corner-to-corner of its bounding box;
          // flips choose which diagonal.
          const [y1, y2] = sh.flipV ? [100, 0] : [0, 100];
          const [x1, x2] = sh.flipH ? [100, 0] : [0, 100];
          return (
            <svg
              key={sh.id}
              className="absolute overflow-visible"
              style={box}
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
            >
              <line
                x1={x1} y1={y1} x2={x2} y2={y2}
                stroke={sh.color}
                strokeWidth={Math.max(1, (sh.width / EMU_PER_INCH) * 96)}
                strokeDasharray={sh.dash ? "6 4" : undefined}
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          );
        }

        if (sh.kind === "pic") {
          const url = urls.get(sh.media);
          const fw = Math.max(0.001, 1 - sh.crop.l - sh.crop.r);
          const fh = Math.max(0.001, 1 - sh.crop.t - sh.crop.b);
          return (
            <div
              key={sh.id}
              className="absolute overflow-hidden"
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

        return <TextBox key={sh.id} sh={sh} box={box} cqw={cqw} />;
      })}

      {!thumb &&
        shapes
          .filter((sh) => highlight?.has(sh.id))
          .map((sh) => (
            <span
              key={`marker-${sh.id}`}
              data-finding-marker
              aria-label="Finding location"
              className="pointer-events-none absolute z-10 box-border border-[3px] border-rose-500"
              style={{
                left: pct(sh.rect.x, W),
                top: pct(sh.rect.y, H),
                width: pct(sh.rect.w, W),
                height: pct(sh.rect.h, H),
              }}
            >
              <span className="absolute -left-1.5 -top-1.5 h-3 w-3 bg-rose-500 ring-2 ring-white dark:ring-zinc-950" />
            </span>
          ))}
    </div>
  );
}

function TextBox({
  sh,
  box,
  cqw,
}: {
  sh: TextShape;
  box: React.CSSProperties;
  cqw: (emu: number) => string;
}) {
  const pt = sh.paragraphs.flatMap((p) => p.sizes)[0] ?? 14;
  const justify = sh.anchor === "center" ? "center" : sh.anchor === "bottom" ? "flex-end" : "flex-start";
  const ptCqw = (points: number) => cqw(points * EMU_PER_PT);

  // Geometry: real corner radius for roundRect/ellipse, clip-path approximations
  // for the rest. Unknown presets stay rectangles.
  const minSide = Math.min(sh.rect.w, sh.rect.h);
  const borderRadius =
    sh.geom === "ellipse" ? "50%" : sh.geom === "roundRect" ? cqw(minSide * (sh.radius ?? 0.16667)) : undefined;
  const clipPath = sh.geom ? CLIP[sh.geom] : undefined;

  const [l, t, r, b] = sh.insets ?? [91440, 45720, 91440, 45720];

  return (
    <div
      className="absolute flex flex-col overflow-hidden"
      style={{
        ...box,
        justifyContent: justify,
        background: fillCss(sh.fill),
        border: sh.line ? `${Math.max(1, (sh.line.width / EMU_PER_INCH) * 96)}px ${sh.line.dash ? "dashed" : "solid"} ${sh.line.color}` : undefined,
        borderRadius,
        clipPath,
        transform: sh.rot ? `rotate(${sh.rot}deg)` : undefined,
        padding: `${cqw(t)} ${cqw(r)} ${cqw(b)} ${cqw(l)}`,
        fontSize: ptCqw(pt),
        lineHeight: 1.18,
      }}
    >
      {sh.paragraphs.map((p, i) => {
        const paraPt = p.sizes[0] ?? pt;
        return (
          <p
            key={i}
            className="whitespace-pre-wrap"
            style={{
              textAlign: p.align,
              paddingLeft: p.marL ? cqw(p.marL) : undefined,
              textIndent: p.bullet ? `-0.9em` : undefined,
              lineHeight: p.lineSpacing ? p.lineSpacing * 1.18 : undefined,
            }}
          >
            {p.bullet && (
              <span style={{ color: p.runs[0]?.color ?? "#111827", fontSize: paraPt !== pt ? ptCqw(paraPt) : undefined }}>
                {p.bullet}&nbsp;
              </span>
            )}
            {p.runs.map((r2, j) => {
              const spec = r2.font ? normalizeFont(r2.font) : null;
              return (
                <span
                  key={j}
                  style={{
                    color: r2.color ?? "#111827",
                    fontSize: r2.size !== undefined && r2.size !== pt ? ptCqw(r2.size) : undefined,
                    fontFamily: spec ? `"${spec.family}", ui-sans-serif, sans-serif` : undefined,
                    fontWeight: r2.bold ? 700 : spec && spec.weight !== 400 ? spec.weight : undefined,
                    fontStyle: r2.italic ? "italic" : undefined,
                    textDecoration: r2.underline ? "underline" : undefined,
                  }}
                >
                  {r2.text}
                </span>
              );
            })}
          </p>
        );
      })}
    </div>
  );
}
