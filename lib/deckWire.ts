import type { Deck, MediaInfo, Slide } from "./types";

export const DECK_WIRE_HEADER = "stream-v1";
export const DECK_WIRE_TYPE = "application/x-proposal-deck-stream";

const FRAME_PROGRESS = 1;
const FRAME_MANIFEST = 2;
const FRAME_ASSET = 3;
const FRAME_ERROR = 255;
const MAX_FRAME_BYTES = 300 * 1024 * 1024;
const ASSET_CHUNK_BYTES = 64 * 1024;

export type ImportPhase = "download" | "prepare" | "transfer";

export interface ImportProgress {
  phase: ImportPhase;
  loaded: number;
  total: number | null;
}

interface WireAsset {
  path: string;
  type: string;
  size: number;
}

interface WireDeckV1 {
  version: 1;
  name: string;
  widthEmu: number;
  heightEmu: number;
  slides: Slide[];
  media: [string, MediaInfo][];
  assets: WireAsset[];
  sourceBytes: number | null;
  assetBytes: number;
}

export interface ImportedDeck {
  name: string;
  deck: Deck;
  sourceBytes: number | null;
  assetBytes: number;
}

/** Writes progress plus processed deck assets into one serverless streaming response. */
export class DeckWireWriter {
  constructor(private readonly output: WritableStreamDefaultWriter<Uint8Array>) {}

  async progress(progress: ImportProgress) {
    await this.json(FRAME_PROGRESS, progress);
  }

  async error(message: string) {
    await this.json(FRAME_ERROR, { message });
  }

  async close() {
    await this.output.close();
  }

  async abort(reason: unknown) {
    await this.output.abort(reason);
  }

  async deck(name: string, deck: Deck, sourceBytes: number | null) {
    const entries = [...deck.blobs];
    const assets = entries.map(([path, blob]) => ({ path, type: blob.type, size: blob.size }));
    const assetBytes = assets.reduce((total, asset) => total + asset.size, 0);
    const manifest: WireDeckV1 = {
      version: 1,
      name,
      widthEmu: deck.widthEmu,
      heightEmu: deck.heightEmu,
      slides: deck.slides,
      media: [...deck.media],
      assets,
      sourceBytes,
      assetBytes,
    };
    await this.json(FRAME_MANIFEST, manifest);
    await this.progress({ phase: "transfer", loaded: 0, total: assetBytes });

    let transferred = 0;
    for (let index = 0; index < entries.length; index++) {
      const [path, blob] = entries[index];
      const asset = assets[index];
      if (!asset || asset.path !== path) throw new Error(`Missing wire metadata for ${path}.`);
      if (asset.size === 0) {
        await this.write(frameHeader(FRAME_ASSET, 0));
        await this.progress({ phase: "transfer", loaded: transferred, total: assetBytes });
        continue;
      }

      const reader = blob.stream().getReader();
      let assetTransferred = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (chunk.value.byteLength === 0) continue;
        for (let offset = 0; offset < chunk.value.byteLength; offset += ASSET_CHUNK_BYTES) {
          const part = chunk.value.subarray(offset, Math.min(chunk.value.byteLength, offset + ASSET_CHUNK_BYTES));
          assetTransferred += part.byteLength;
          if (assetTransferred > asset.size) throw new Error(`Processed asset ${path} exceeded its declared size.`);
          await this.write(frameHeader(FRAME_ASSET, part.byteLength));
          await this.write(part);
          transferred += part.byteLength;
          await this.progress({ phase: "transfer", loaded: transferred, total: assetBytes });
        }
      }
      if (assetTransferred !== asset.size) throw new Error(`Processed asset ${path} ended early.`);
    }
  }

  private async json(type: number, value: unknown) {
    const payload = new TextEncoder().encode(JSON.stringify(value));
    await this.write(frameHeader(type, payload.byteLength));
    await this.write(payload);
  }

  private async write(bytes: Uint8Array) {
    await this.output.write(bytes);
  }
}

/** Rehydrates Maps and Blobs while progress frames arrive from server. */
export async function deckFromResponse(
  response: Response,
  onProgress?: (progress: ImportProgress) => void,
): Promise<ImportedDeck> {
  if (response.headers.get("x-deck-transfer") !== DECK_WIRE_HEADER) {
    throw new Error("Server returned an unsupported presentation format.");
  }
  if (!response.body) throw new Error("Server returned an empty presentation stream.");

  const input = new StreamBytes(response.body.getReader());
  let manifest: WireDeckV1 | null = null;
  let assetIndex = 0;
  let assetLoaded = 0;
  let assetParts: ArrayBuffer[] = [];
  const blobs = new Map<string, Blob>();

  while (true) {
    const header = await input.read(5, true);
    if (!header) break;
    const type = header[0];
    const length = new DataView(header.buffer, header.byteOffset + 1, 4).getUint32(0);
    if (length > MAX_FRAME_BYTES) throw new Error("Processed presentation frame is too large.");

    if (type === FRAME_ASSET) {
      if (!manifest) throw new Error("Processed presentation asset arrived before manifest.");
      const asset = manifest.assets[assetIndex];
      if (!asset || length > asset.size - assetLoaded || (length === 0 && asset.size !== 0)) {
        throw new Error("Processed presentation asset length is invalid.");
      }
      const parts = await input.readParts(length);
      if (!parts) throw new Error("Processed presentation stream ended early.");
      assetParts.push(...parts.map(asBlobPart));
      assetLoaded += length;
      if (assetLoaded === asset.size) {
        blobs.set(asset.path, new Blob(assetParts, { type: asset.type }));
        assetIndex++;
        assetLoaded = 0;
        assetParts = [];
      }
      continue;
    }

    if (length > 32 * 1024 * 1024) throw new Error("Processed presentation metadata is too large.");
    const payload = await input.read(length);
    if (!payload) throw new Error("Processed presentation stream ended early.");
    const value = JSON.parse(new TextDecoder().decode(payload)) as unknown;

    if (type === FRAME_PROGRESS) {
      const progress = parseProgress(value);
      onProgress?.(progress);
    } else if (type === FRAME_MANIFEST) {
      manifest = parseManifest(value);
    } else if (type === FRAME_ERROR) {
      const message = typeof value === "object" && value !== null && "message" in value
        ? String((value as { message: unknown }).message)
        : "Server could not prepare this presentation.";
      throw new Error(message);
    } else {
      throw new Error("Processed presentation contains an unknown frame.");
    }
  }

  if (!manifest) throw new Error("Processed presentation is missing its manifest.");
  if (assetIndex !== manifest.assets.length || assetLoaded !== 0) {
    throw new Error("Processed presentation is missing preview assets.");
  }

  return {
    name: manifest.name,
    deck: {
      widthEmu: manifest.widthEmu,
      heightEmu: manifest.heightEmu,
      slides: manifest.slides,
      media: new Map(manifest.media),
      blobs,
    },
    sourceBytes: manifest.sourceBytes,
    assetBytes: manifest.assetBytes,
  };
}

function frameHeader(type: number, length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0 || length > 0xffff_ffff) {
    throw new Error("Processed presentation frame cannot be encoded.");
  }
  const header = new Uint8Array(5);
  header[0] = type;
  new DataView(header.buffer).setUint32(1, length);
  return header;
}

function asBlobPart(part: Uint8Array<ArrayBufferLike>): ArrayBuffer {
  if (part.buffer instanceof ArrayBuffer) {
    if (part.byteOffset === 0 && part.byteLength === part.buffer.byteLength) return part.buffer;
    return part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength);
  }
  const copy = new Uint8Array(part.byteLength);
  copy.set(part);
  return copy.buffer;
}

function parseProgress(value: unknown): ImportProgress {
  if (
    typeof value !== "object" ||
    value === null ||
    !("phase" in value) ||
    !(["download", "prepare", "transfer"] as const).includes((value as { phase: ImportPhase }).phase) ||
    !("loaded" in value) ||
    !Number.isFinite(Number((value as { loaded: unknown }).loaded))
  ) {
    throw new Error("Processed presentation progress is invalid.");
  }
  const total = "total" in value && (value as { total: unknown }).total !== null
    ? Number((value as { total: unknown }).total)
    : null;
  return {
    phase: (value as { phase: ImportPhase }).phase,
    loaded: Number((value as { loaded: unknown }).loaded),
    total: total !== null && Number.isFinite(total) ? total : null,
  };
}

function parseManifest(value: unknown): WireDeckV1 {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !("widthEmu" in value) ||
    !Number.isFinite(Number(value.widthEmu)) ||
    !("heightEmu" in value) ||
    !Number.isFinite(Number(value.heightEmu)) ||
    !("slides" in value) ||
    !Array.isArray(value.slides) ||
    !("media" in value) ||
    !Array.isArray(value.media) ||
    !("assets" in value) ||
    !Array.isArray(value.assets)
  ) {
    throw new Error("Processed presentation manifest is invalid.");
  }
  return value as unknown as WireDeckV1;
}

class StreamBytes {
  private chunk: Uint8Array<ArrayBufferLike> = new Uint8Array();
  private offset = 0;
  private ended = false;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async read(length: number, allowCleanEof = false): Promise<Uint8Array | null> {
    const parts = await this.readParts(length, allowCleanEof);
    if (!parts) return null;
    if (parts.length === 1) return parts[0];
    const output = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      output.set(part, offset);
      offset += part.byteLength;
    }
    return output;
  }

  async readParts(length: number, allowCleanEof = false): Promise<Uint8Array[] | null> {
    const parts: Uint8Array[] = [];
    let remaining = length;
    while (remaining > 0) {
      if (this.offset >= this.chunk.byteLength) {
        if (this.ended) {
          if (allowCleanEof && parts.length === 0 && remaining === length) return null;
          throw new Error("Processed presentation stream ended early.");
        }
        const next = await this.reader.read();
        if (next.done) {
          this.ended = true;
          continue;
        }
        this.chunk = next.value;
        this.offset = 0;
      }
      const take = Math.min(remaining, this.chunk.byteLength - this.offset);
      parts.push(this.chunk.subarray(this.offset, this.offset + take));
      this.offset += take;
      remaining -= take;
    }
    return parts;
  }
}
