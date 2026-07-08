import type { ImageFormat } from "./types";

export interface HeaderDims {
  width: number;
  height: number;
  format: ImageFormat;
  mediaType: string;
}

/**
 * Read intrinsic pixel dimensions straight out of the file header.
 * Avoids decoding 140MB of PNGs just to learn their size.
 */
export function readImageHeader(b: Uint8Array): HeaderDims {
  if (isPng(b)) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return {
      width: v.getUint32(16),
      height: v.getUint32(20),
      format: "png",
      mediaType: "image/png",
    };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    const d = jpegDims(b);
    if (d) return { ...d, format: "jpg", mediaType: "image/jpeg" };
  }
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return {
      width: v.getUint16(6, true),
      height: v.getUint16(8, true),
      format: "gif",
      mediaType: "image/gif",
    };
  }
  if (isWebp(b)) {
    const d = webpDims(b);
    if (d) return { ...d, format: "webp", mediaType: "image/webp" };
  }
  return { width: 0, height: 0, format: "unknown", mediaType: "application/octet-stream" };
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const isPng = (b: Uint8Array) => b.length > 24 && PNG_SIG.every((v, i) => b[i] === v);

const isWebp = (b: Uint8Array) =>
  b.length > 30 &&
  b[0] === 0x52 &&
  b[1] === 0x49 &&
  b[2] === 0x46 &&
  b[3] === 0x46 &&
  b[8] === 0x57 &&
  b[9] === 0x45 &&
  b[10] === 0x42 &&
  b[11] === 0x50;

/** Walk JPEG markers to the first Start-Of-Frame segment. */
function jpegDims(b: Uint8Array): { width: number; height: number } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1];
    // SOF0-3, SOF5-7, SOF9-11, SOF13-15 carry the frame header.
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      return { height: v.getUint16(i + 5), width: v.getUint16(i + 7) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xda) break; // start of scan; no SOF found
    const len = v.getUint16(i + 2);
    if (len < 2) break;
    i += 2 + len;
  }
  return null;
}

function webpDims(b: Uint8Array): { width: number; height: number } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const fourcc = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (fourcc === "VP8X") {
    const w = (b[24] | (b[25] << 8) | (b[26] << 16)) + 1;
    const h = (b[27] | (b[28] << 8) | (b[29] << 16)) + 1;
    return { width: w, height: h };
  }
  if (fourcc === "VP8 ") {
    return { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff };
  }
  if (fourcc === "VP8L") {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}
