import { unzipSync, strFromU8 } from "fflate";
import { readImageHeader } from "./imageHeader";
import {
  applyClrMap,
  parseFontScheme,
  parseScheme,
  resolveBackground,
  resolveColor,
  resolveFill,
  resolveLine,
  type Scheme,
  type ThemeFonts,
} from "./color";
import type { Align, Anchor, Crop, CxnShape, Deck, Fill, MediaInfo, Para, PicShape, Rect, Run, Shape, Slide, TextShape } from "./types";

const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** Affine map from a shape's local coords to slide coords (groups nest these). */
interface Transform {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
}
const IDENTITY: Transform = { sx: 1, sy: 1, tx: 0, ty: 0 };

/** Everything a shape needs to resolve colours and fonts against its master. */
interface Ctx {
  scheme: Scheme;
  fonts: ThemeFonts;
}

interface MasterLayer {
  ctx: Ctx;
  bg?: Fill;
  shapes: Shape[];
}

interface LayoutLayer {
  master: MasterLayer;
  bg?: Fill;
  shapes: Shape[];
  showsMasterShapes: boolean;
}

export function parsePptx(buf: ArrayBuffer): Deck {
  const wanted = (name: string) =>
    name === "ppt/presentation.xml" ||
    name === "ppt/_rels/presentation.xml.rels" ||
    name.startsWith("ppt/theme/") ||
    name.startsWith("ppt/media/") ||
    /^ppt\/slide(Layout|Master)s\/[^/]+\.xml$/.test(name) ||
    /^ppt\/slide(Layout|Master)s\/_rels\/[^/]+\.rels$/.test(name) ||
    /^ppt\/slides\/slide\d+\.xml$/.test(name) ||
    /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(name);

  const files = unzipSync(new Uint8Array(buf), { filter: (f) => wanted(f.name) });

  const media = new Map<string, MediaInfo>();
  const blobs = new Map<string, Blob>();
  for (const [path, bytes] of Object.entries(files)) {
    if (!path.startsWith("ppt/media/")) continue;
    const head = readImageHeader(bytes);
    media.set(path, {
      path,
      bytes: bytes.length,
      width: head.width,
      height: head.height,
      format: path.toLowerCase().endsWith(".svg") ? "svg" : head.format,
      mediaType: head.mediaType,
    });
    // Hand the array straight to the Blob; fflate gives each entry its own
    // buffer, so there is nothing to alias and no reason to copy 140MB twice.
    blobs.set(path, new Blob([bytes], { type: head.mediaType }));
  }

  const parser = new DOMParser();
  const xml = (path: string) => parser.parseFromString(strFromU8(files[path]), "application/xml");

  const pres = xml("ppt/presentation.xml");
  const sldSz = pres.getElementsByTagNameNS(NS_P, "sldSz")[0];
  const widthEmu = num(sldSz?.getAttribute("cx"), 9144000);
  const heightEmu = num(sldSz?.getAttribute("cy"), 6858000);

  // --- inheritance chain: slide → layout → master → theme --------------------
  // Backgrounds, colour maps, and theme fonts live up the chain. Parse each
  // layout/master/theme once and hand every slide its master's context.
  const relsFor = (path: string): Map<string, string> => {
    const dir = path.slice(0, path.lastIndexOf("/") + 1);
    const rp = `${dir}_rels/${path.slice(path.lastIndexOf("/") + 1)}.rels`;
    return files[rp] ? relMap(xml(rp), dir) : new Map();
  };
  const firstRelTo = (rels: Map<string, string>, contains: string) =>
    [...rels.values()].find((t) => t.includes(contains));

  const masterCache = new Map<string, MasterLayer>();
  const masterOf = (masterPath: string) => {
    let m = masterCache.get(masterPath);
    if (!m) {
      const doc = files[masterPath] ? xml(masterPath) : null;
      const themePath = doc ? firstRelTo(relsFor(masterPath), "theme/") : undefined;
      const themeDoc = themePath && files[themePath] ? xml(themePath) : null;
      const clrMapEl = doc?.getElementsByTagNameNS(NS_P, "clrMap")[0] ?? null;
      const scheme = applyClrMap(parseScheme(themeDoc), clrMapEl);
      const ctx = { scheme, fonts: parseFontScheme(themeDoc) };
      const shapes: Shape[] = [];
      const tree = doc?.getElementsByTagNameNS(NS_P, "spTree")[0];
      if (tree) walk(tree, IDENTITY, relsFor(masterPath), shapes, `master-${masterPath}`, ctx);
      m = { ctx, bg: doc ? resolveBackground(doc, scheme) : undefined, shapes };
      masterCache.set(masterPath, m);
    }
    return m;
  };

  const layoutCache = new Map<string, LayoutLayer>();
  const layoutOf = (layoutPath: string) => {
    let l = layoutCache.get(layoutPath);
    if (!l) {
      const doc = files[layoutPath] ? xml(layoutPath) : null;
      const masterPath = doc ? firstRelTo(relsFor(layoutPath), "slideMasters/") : undefined;
      const master = masterOf(masterPath ?? "ppt/slideMasters/slideMaster1.xml");
      const shapes: Shape[] = [];
      const tree = doc?.getElementsByTagNameNS(NS_P, "spTree")[0];
      if (tree) walk(tree, IDENTITY, relsFor(layoutPath), shapes, `layout-${layoutPath}`, master.ctx);
      l = {
        master,
        bg: doc ? resolveBackground(doc, master.ctx.scheme) : undefined,
        shapes,
        showsMasterShapes: doc?.documentElement.getAttribute("showMasterSp") !== "0",
      };
      layoutCache.set(layoutPath, l);
    }
    return l;
  };

  const presRels = relMap(xml("ppt/_rels/presentation.xml.rels"), "ppt/");
  const sldIds = Array.from(pres.getElementsByTagNameNS(NS_P, "sldId"));
  const slidePaths = sldIds
    .map((el) => presRels.get(el.getAttributeNS(NS_R, "id") ?? ""))
    .filter((p): p is string => !!p && !!files[p]);

  const slides: Slide[] = slidePaths.map((path, i) => {
    const doc = xml(path);
    const rels = relsFor(path);
    const layoutPath = firstRelTo(rels, "slideLayouts/");
    const layout = layoutOf(layoutPath ?? "ppt/slideLayouts/slideLayout1.xml");
    const ctx = layout.master.ctx;

    const tree = doc.getElementsByTagNameNS(NS_P, "spTree")[0];
    const shapes: Shape[] = [];
    if (tree) walk(tree, IDENTITY, rels, shapes, `s${i + 1}`, ctx);
    return {
      index: i + 1,
      // Slide XML contains only slide-specific content. Rebuild the visual
      // stack from master -> layout -> slide so branded panels, footer bars,
      // and master logos are present without contaminating rule checks.
      backgroundShapes: [
        ...(doc.documentElement.getAttribute("showMasterSp") !== "0" && layout.showsMasterShapes ? layout.master.shapes : []),
        ...layout.shapes,
      ],
      shapes,
      background: resolveBackground(doc, ctx.scheme) ?? layout.bg ?? layout.master.bg,
    };
  });

  return { widthEmu, heightEmu, slides, media, blobs };
}

// ---------------------------------------------------------------- shape tree

function walk(
  parent: Element,
  tf: Transform,
  rels: Map<string, string>,
  out: Shape[],
  idPrefix: string,
  ctx: Ctx,
) {
  let n = 0;
  for (const child of elementChildren(parent)) {
    if (child.namespaceURI !== NS_P) continue;
    if (firstNS(child, NS_P, "cNvPr")?.getAttribute("hidden") === "1") continue;
    const id = `${idPrefix}-${n++}`;
    switch (child.localName) {
      case "grpSp": {
        const g = groupTransform(child, tf);
        walk(child, g, rels, out, id, ctx);
        break;
      }
      case "pic": {
        const pic = readPic(child, tf, rels, id);
        if (pic) out.push(pic);
        break;
      }
      case "cxnSp": {
        // Connectors are lines. Fed through readText they'd render as boxes.
        const c = readCxn(child, tf, id, ctx.scheme);
        if (c) out.push(c);
        break;
      }
      case "sp":
      case "graphicFrame": {
        const t = readText(child, tf, id, ctx);
        if (t) out.push(t);
        break;
      }
    }
  }
}

function readCxn(el: Element, tf: Transform, id: string, scheme: Scheme): CxnShape | null {
  const spPr = firstNS(el, NS_P, "spPr");
  const line = resolveLine(spPr, scheme);
  if (!line) return null;
  const rect = rectOf(el, tf);
  if (!rect) return null;
  const xfrm = spPr ? childNS(spPr, NS_A, "xfrm") : null;
  return {
    kind: "cxn",
    id,
    rect,
    color: line.color,
    width: line.width,
    dash: line.dash,
    flipH: xfrm?.getAttribute("flipH") === "1",
    flipV: xfrm?.getAttribute("flipV") === "1",
  };
}

/** A group remaps child coords: global = off + (local - chOff) * (ext / chExt). */
function groupTransform(grp: Element, tf: Transform): Transform {
  const xfrm = firstNS(grp, NS_A, "xfrm");
  if (!xfrm) return tf;
  const off = offOf(xfrm);
  const ext = extOf(xfrm);
  const chOff = ptOf(firstNS(xfrm, NS_A, "chOff"));
  const chExt = extOf(xfrm, "chExt");
  if (!off || !ext || !chOff || !chExt || chExt.cx === 0 || chExt.cy === 0) return tf;
  const kx = ext.cx / chExt.cx;
  const ky = ext.cy / chExt.cy;
  return {
    sx: tf.sx * kx,
    sy: tf.sy * ky,
    tx: tf.tx + tf.sx * (off.x - chOff.x * kx),
    ty: tf.ty + tf.sy * (off.y - chOff.y * ky),
  };
}

function readPic(el: Element, tf: Transform, rels: Map<string, string>, id: string): PicShape | null {
  const blip = firstNS(el, NS_A, "blip");
  const embed = blip?.getAttributeNS(NS_R, "embed");
  const mediaPath = embed ? rels.get(embed) : undefined;
  if (!mediaPath) return null;

  const rect = rectOf(el, tf);
  if (!rect) return null;

  const src = firstNS(el, NS_A, "srcRect");
  const crop: Crop = {
    l: num(src?.getAttribute("l"), 0) / 100000,
    t: num(src?.getAttribute("t"), 0) / 100000,
    r: num(src?.getAttribute("r"), 0) / 100000,
    b: num(src?.getAttribute("b"), 0) / 100000,
  };

  const xfrm = firstNS(el, NS_A, "xfrm");
  const cNvPr = firstNS(el, NS_P, "cNvPr");

  return {
    kind: "pic",
    id,
    name: cNvPr?.getAttribute("name") ?? "",
    descr: cNvPr?.getAttribute("title") ?? cNvPr?.getAttribute("descr") ?? undefined,
    rect,
    rot: num(xfrm?.getAttribute("rot"), 0) / 60000,
    flipH: xfrm?.getAttribute("flipH") === "1",
    flipV: xfrm?.getAttribute("flipV") === "1",
    media: mediaPath,
    crop,
  };
}

const ALIGN: Record<string, Align> = { l: "left", ctr: "center", r: "right", just: "justify" };
const ANCHOR: Record<string, Anchor> = { t: "top", ctr: "center", b: "bottom" };

function readText(el: Element, tf: Transform, id: string, ctx: Ctx): TextShape | null {
  const { scheme, fonts } = ctx;
  // "+mj-lt"/"+mn-lt" are theme font references, not typeface names.
  const themeFace = (face: string | null | undefined): string | undefined => {
    if (!face) return undefined;
    if (face.startsWith("+mj")) return fonts.major;
    if (face.startsWith("+mn")) return fonts.minor;
    return face;
  };

  const paras: Para[] = [];
  for (const p of Array.from(el.getElementsByTagNameNS(NS_A, "p"))) {
    const runs: Run[] = [];

    for (const node of elementChildren(p)) {
      if (node.namespaceURI !== NS_A) continue;
      if (node.localName === "br") {
        runs.push({ text: "\n" });
      } else if (node.localName === "r" || node.localName === "fld") {
        const text = firstNS(node, NS_A, "t")?.textContent ?? "";
        if (!text) continue;
        const rPr = firstNS(node, NS_A, "rPr");
        const sz = rPr?.getAttribute("sz");
        runs.push({
          text,
          size: sz ? num(sz, 0) / 100 : undefined,
          color: resolveColor(rPr ? childNS(rPr, NS_A, "solidFill") : null, scheme) ?? undefined,
          font: themeFace((rPr ? childNS(rPr, NS_A, "latin") : null)?.getAttribute("typeface")),
          bold: rPr?.getAttribute("b") === "1" || undefined,
          italic: rPr?.getAttribute("i") === "1" || undefined,
          underline: (rPr?.getAttribute("u") ?? "none") !== "none" || undefined,
        });
      }
    }

    const text = runs.map((r) => r.text).join("");
    if (text.trim()) {
      const pPr = firstNS(p, NS_A, "pPr");
      const align = pPr ? ALIGN[pPr.getAttribute("algn") ?? ""] : undefined;

      // Bullet: an explicit buChar wins; buNone/absent means none.
      const buChar = pPr ? childNS(pPr, NS_A, "buChar")?.getAttribute("char") : null;
      const marL = num(pPr?.getAttribute("marL"), 0);

      // Line spacing: percent of single spacing, or absolute points.
      let lineSpacing: number | undefined;
      const lnSpc = pPr ? childNS(pPr, NS_A, "lnSpc") : null;
      const pct = lnSpc ? childNS(lnSpc, NS_A, "spcPct")?.getAttribute("val") : null;
      const pts = lnSpc ? childNS(lnSpc, NS_A, "spcPts")?.getAttribute("val") : null;
      if (pct) lineSpacing = num(pct, 100000) / 100000;
      else if (pts) {
        const firstSize = runs.find((r) => r.size)?.size ?? 14;
        lineSpacing = num(pts, 0) / 100 / firstSize;
      }

      paras.push({
        text,
        sizes: runs.map((r) => r.size).filter((s): s is number => s !== undefined),
        runs,
        align,
        bullet: buChar ?? undefined,
        marL: marL > 0 ? marL : undefined,
        lineSpacing,
      });
    }
  }

  const spPr = firstNS(el, NS_P, "spPr");
  const fill = resolveFill(spPr, scheme);
  const line = resolveLine(spPr, scheme);

  // Preset geometry. roundRect's corner radius comes from its adj guide,
  // as a fraction (val/100000) of the shorter side; PowerPoint's default is 16.67%.
  const prstGeom = spPr ? childNS(spPr, NS_A, "prstGeom") : null;
  const geom = prstGeom?.getAttribute("prst") ?? undefined;

  // A connector authored as <p:sp> would box-render its stroke; drop it rather
  // than draw a rectangle where the deck has a line.
  if (!paras.length && geom && /connector|^line$/i.test(geom)) return null;

  // Keep text-free shapes only when they carry visible paint — those are the
  // decorative rectangles (footer bars, banners) that make a slide look right.
  // Drop genuinely empty shapes so they add no noise.
  if (!paras.length && !fill && !line) return null;

  const rect = rectOf(el, tf) ?? { x: 0, y: 0, w: 0, h: 0 };
  const cNvPr = firstNS(el, NS_P, "cNvPr");
  const ph = firstNS(el, NS_P, "ph");
  const bodyPr = firstNS(el, NS_A, "bodyPr");
  const xfrm = spPr ? childNS(spPr, NS_A, "xfrm") : null;
  let radius: number | undefined;
  if (geom === "roundRect") {
    const gd = prstGeom ? firstNS(prstGeom, NS_A, "gd") : null;
    const m = /val (\d+)/.exec(gd?.getAttribute("fmla") ?? "");
    radius = m ? Number(m[1]) / 100000 : 0.16667;
  }

  // Text insets: PowerPoint defaults are 0.1in left/right, 0.05in top/bottom.
  const insets: [number, number, number, number] = [
    num(bodyPr?.getAttribute("lIns"), 91440),
    num(bodyPr?.getAttribute("tIns"), 45720),
    num(bodyPr?.getAttribute("rIns"), 91440),
    num(bodyPr?.getAttribute("bIns"), 45720),
  ];

  return {
    kind: "text",
    id,
    name: cNvPr?.getAttribute("name") ?? "",
    rect,
    rot: num(xfrm?.getAttribute("rot"), 0) / 60000,
    paragraphs: paras,
    placeholder: ph?.getAttribute("type") ?? (ph ? "body" : undefined),
    fill,
    line,
    anchor: bodyPr ? ANCHOR[bodyPr.getAttribute("anchor") ?? ""] : undefined,
    geom,
    radius,
    insets,
  };
}

// ---------------------------------------------------------------- xml helpers

function rectOf(el: Element, tf: Transform): Rect | null {
  // graphicFrame uses p:xfrm; everything else uses a:xfrm.
  const xfrm = firstNS(el, NS_A, "xfrm") ?? firstNS(el, NS_P, "xfrm");
  if (!xfrm) return null;
  const off = offOf(xfrm);
  const ext = extOf(xfrm);
  if (!off || !ext) return null;
  return {
    x: tf.tx + tf.sx * off.x,
    y: tf.ty + tf.sy * off.y,
    w: tf.sx * ext.cx,
    h: tf.sy * ext.cy,
  };
}

const offOf = (xfrm: Element) => ptOf(firstNS(xfrm, NS_A, "off"));

function ptOf(el: Element | null) {
  if (!el) return null;
  return { x: num(el.getAttribute("x"), 0), y: num(el.getAttribute("y"), 0) };
}

function extOf(xfrm: Element, tag: "ext" | "chExt" = "ext") {
  const el = firstNS(xfrm, NS_A, tag);
  if (!el) return null;
  return { cx: num(el.getAttribute("cx"), 0), cy: num(el.getAttribute("cy"), 0) };
}

/** First descendant with this namespace + local name (document order). */
function firstNS(root: Element, ns: string, local: string): Element | null {
  return root.getElementsByTagNameNS(ns, local)[0] ?? null;
}

/** First *direct child* with this namespace + local name — avoids matching nested copies. */
function childNS(root: Element, ns: string, local: string): Element | null {
  for (const c of elementChildren(root)) if (c.namespaceURI === ns && c.localName === local) return c;
  return null;
}

/** `.children` is not universal across DOM implementations; walk childNodes. */
function elementChildren(el: Element): Element[] {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1) out.push(n as Element);
  }
  return out;
}

function relMap(doc: Document, baseDir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rel of Array.from(doc.getElementsByTagName("Relationship"))) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (!id || !target || rel.getAttribute("TargetMode") === "External") continue;
    map.set(id, resolvePath(baseDir, target));
  }
  return map;
}

function resolvePath(baseDir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = baseDir.split("/").filter(Boolean);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  return parts.join("/");
}

function num(v: string | null | undefined, fallback: number): number {
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
