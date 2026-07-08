import { unzipSync, strFromU8 } from "fflate";
import { readImageHeader } from "./imageHeader";
import { parseScheme, resolveBackground, resolveColor, resolveFill, resolveLine, type Scheme } from "./color";
import type { Align, Anchor, Crop, Deck, MediaInfo, Para, PicShape, Rect, Shape, Slide, TextShape } from "./types";

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

export function parsePptx(buf: ArrayBuffer): Deck {
  const wanted = (name: string) =>
    name === "ppt/presentation.xml" ||
    name === "ppt/_rels/presentation.xml.rels" ||
    name === "ppt/theme/theme1.xml" ||
    name.startsWith("ppt/media/") ||
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

  const scheme = parseScheme(files["ppt/theme/theme1.xml"] ? xml("ppt/theme/theme1.xml") : null);

  const presRels = relMap(xml("ppt/_rels/presentation.xml.rels"), "ppt/");
  const sldIds = Array.from(pres.getElementsByTagNameNS(NS_P, "sldId"));
  const slidePaths = sldIds
    .map((el) => presRels.get(el.getAttributeNS(NS_R, "id") ?? ""))
    .filter((p): p is string => !!p && !!files[p]);

  const slides: Slide[] = slidePaths.map((path, i) => {
    const doc = xml(path);
    const relsPath = path.replace(/slides\/(slide\d+\.xml)$/, "slides/_rels/$1.rels");
    const rels = files[relsPath] ? relMap(xml(relsPath), "ppt/slides/") : new Map<string, string>();
    const tree = doc.getElementsByTagNameNS(NS_P, "spTree")[0];
    const shapes: Shape[] = [];
    if (tree) walk(tree, IDENTITY, rels, shapes, `s${i + 1}`, scheme);
    return { index: i + 1, shapes, background: resolveBackground(doc, scheme) };
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
  scheme: Scheme,
) {
  let n = 0;
  for (const child of elementChildren(parent)) {
    if (child.namespaceURI !== NS_P) continue;
    const id = `${idPrefix}-${n++}`;
    switch (child.localName) {
      case "grpSp": {
        const g = groupTransform(child, tf);
        walk(child, g, rels, out, id, scheme);
        break;
      }
      case "pic": {
        const pic = readPic(child, tf, rels, id);
        if (pic) out.push(pic);
        break;
      }
      case "sp":
      case "graphicFrame":
      case "cxnSp": {
        const t = readText(child, tf, id, scheme);
        if (t) out.push(t);
        break;
      }
    }
  }
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

function readText(el: Element, tf: Transform, id: string, scheme: Scheme): TextShape | null {
  const paras: Para[] = [];
  for (const p of Array.from(el.getElementsByTagNameNS(NS_A, "p"))) {
    let text = "";
    const sizes: number[] = [];
    let color: string | undefined;
    let bold: boolean | undefined;

    for (const node of elementChildren(p)) {
      if (node.namespaceURI !== NS_A) continue;
      if (node.localName === "br") {
        text += "\n";
      } else if (node.localName === "r" || node.localName === "fld") {
        const t = firstNS(node, NS_A, "t");
        if (t?.textContent) text += t.textContent;
        const rPr = firstNS(node, NS_A, "rPr");
        const sz = rPr?.getAttribute("sz");
        if (sz) sizes.push(num(sz, 0) / 100);
        // First coloured run sets the paragraph colour — good enough for a preview.
        if (color === undefined) {
          const fill = rPr ? childNS(rPr, NS_A, "solidFill") : null;
          const c = resolveColor(fill, scheme);
          if (c) color = c;
        }
        if (bold === undefined && rPr?.getAttribute("b") === "1") bold = true;
      }
    }
    if (text.trim()) {
      const pPr = firstNS(p, NS_A, "pPr");
      const align = pPr ? ALIGN[pPr.getAttribute("algn") ?? ""] : undefined;
      paras.push({ text, sizes, color, align, bold });
    }
  }
  if (!paras.length) return null;

  const rect = rectOf(el, tf) ?? { x: 0, y: 0, w: 0, h: 0 };
  const cNvPr = firstNS(el, NS_P, "cNvPr");
  const ph = firstNS(el, NS_P, "ph");
  const spPr = firstNS(el, NS_P, "spPr");
  const bodyPr = firstNS(el, NS_A, "bodyPr");
  const xfrm = spPr ? childNS(spPr, NS_A, "xfrm") : null;

  return {
    kind: "text",
    id,
    name: cNvPr?.getAttribute("name") ?? "",
    rect,
    rot: num(xfrm?.getAttribute("rot"), 0) / 60000,
    paragraphs: paras,
    placeholder: ph?.getAttribute("type") ?? (ph ? "body" : undefined),
    fill: resolveFill(spPr, scheme),
    line: resolveLine(spPr, scheme),
    anchor: bodyPr ? ANCHOR[bodyPr.getAttribute("anchor") ?? ""] : undefined,
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
