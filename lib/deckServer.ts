import { randomUUID } from "node:crypto";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

const TABLE = "proposal_checker_deck_events";
const FINGERPRINT_PATTERN = /^deck-v1-[a-f0-9]{16}$/;
const MAX_PAYLOAD_CHARS = 300_000;

export type DeckCaptureSource = "upload" | "google-slides";

export interface DeckSlideCapture {
  index: number;
  texts: string[];
  shapeCount: number;
  textShapeCount: number;
  imageCount: number;
}

export interface DeckMediaCapture {
  format: string;
  bytes: number;
  width: number;
  height: number;
}

export interface DeckCaptureRecord {
  deckFingerprint: string;
  name: string;
  source: DeckCaptureSource;
  sourceUrl?: string;
  slideCount: number;
  widthEmu: number;
  heightEmu: number;
  slides: DeckSlideCapture[];
  media: DeckMediaCapture[];
}

export interface DeckCaptureRow extends DeckCaptureRecord {
  id: string;
  source_url: string | null;
  deck_fingerprint: string;
  slide_count: number;
  width_emu: number;
  height_emu: number;
  slide_data_bytes: number;
  created_at: string | Date;
}

let sql: NeonQueryFunction<false, false> | null = null;
let schemaReady: Promise<void> | null = null;

export function deckCaptureConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL) && process.env.DECK_CAPTURE_ENABLED !== "false";
}

function getSql(): NeonQueryFunction<false, false> {
  if (!process.env.DATABASE_URL) throw new Error("Deck capture database is not configured.");
  if (!sql) sql = neon(process.env.DATABASE_URL);
  return sql;
}

export async function ensureDeckCaptureSchema(): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const db = getSql();
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id TEXT PRIMARY KEY,
        deck_fingerprint TEXT NOT NULL,
        name TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('upload', 'google-slides')),
        source_url TEXT,
        slide_count INTEGER NOT NULL CHECK (slide_count > 0),
        width_emu BIGINT NOT NULL,
        height_emu BIGINT NOT NULL,
        slides JSONB NOT NULL,
        media JSONB NOT NULL,
        slide_data_bytes INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS pc_deck_events_created_idx
      ON ${TABLE} (created_at DESC, id DESC)
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS pc_deck_events_fingerprint_idx
      ON ${TABLE} (deck_fingerprint, created_at DESC)
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS pc_deck_events_source_idx
      ON ${TABLE} (source, created_at DESC)
    `);
  })().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

export async function saveDeckCapture(record: DeckCaptureRecord): Promise<{ id: string } | null> {
  if (!deckCaptureConfigured()) return null;
  const normalized = normalizeRecord(record);
  const payload = JSON.stringify({ slides: normalized.slides, media: normalized.media });
  if (payload.length > MAX_PAYLOAD_CHARS) throw new Error("Deck capture payload is too large.");

  await ensureDeckCaptureSchema();
  const id = `deck-event-v1-${randomUUID()}`;
  await getSql().query(
    `
      INSERT INTO ${TABLE} (
        id, deck_fingerprint, name, source, source_url, slide_count,
        width_emu, height_emu, slides, media, slide_data_bytes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11)
    `,
    [
      id,
      normalized.deckFingerprint,
      normalized.name,
      normalized.source,
      normalized.sourceUrl ?? null,
      normalized.slideCount,
      normalized.widthEmu,
      normalized.heightEmu,
      JSON.stringify(normalized.slides),
      JSON.stringify(normalized.media),
      payload.length,
    ],
  );
  return { id };
}

const ROW_COLUMNS = `
  id, deck_fingerprint, name, source, source_url, slide_count,
  width_emu, height_emu, slides, media, slide_data_bytes, created_at
`;

export function deckRowCursor(row: DeckCaptureRow): string {
  return `${dateIso(row.created_at)}|${row.id}`;
}

export async function listDeckCaptures({
  limit = 50,
  before,
}: {
  limit?: number;
  before?: string;
} = {}): Promise<DeckCaptureRow[]> {
  await ensureDeckCaptureSchema();
  const cursor = parseCursor(before);
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 100);
  const params: unknown[] = [safeLimit];
  let where = "TRUE";
  if (cursor) {
    where = "(created_at, id) < ($2::timestamptz, $3)";
    params.push(cursor.createdAt, cursor.id);
  }
  return (await getSql().query(
    `SELECT ${ROW_COLUMNS} FROM ${TABLE} WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $1`,
    params,
  )) as DeckCaptureRow[];
}

export async function countDeckCaptures(): Promise<number> {
  await ensureDeckCaptureSchema();
  const rows = (await getSql().query(`SELECT COUNT(*)::int AS total FROM ${TABLE}`)) as { total: number }[];
  return rows[0]?.total ?? 0;
}

/** Fallback tuning input when explicit TRAINING_CAPTURE was not enabled. */
export async function latestDeckCaptureFor(deckFingerprint: string): Promise<DeckCaptureRow | null> {
  await ensureDeckCaptureSchema();
  const rows = (await getSql().query(
    `SELECT ${ROW_COLUMNS} FROM ${TABLE} WHERE deck_fingerprint = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [deckFingerprint],
  )) as DeckCaptureRow[];
  return rows[0] ?? null;
}

export async function purgeDeckCaptures(deckFingerprint: string): Promise<number> {
  if (!deckCaptureConfigured()) return 0;
  await ensureDeckCaptureSchema();
  const rows = (await getSql().query(`DELETE FROM ${TABLE} WHERE deck_fingerprint = $1 RETURNING id`, [deckFingerprint])) as {
    id: string;
  }[];
  return rows.length;
}

function normalizeRecord(record: DeckCaptureRecord): DeckCaptureRecord {
  if (!FINGERPRINT_PATTERN.test(record.deckFingerprint)) throw new Error("Invalid deck fingerprint.");
  if (record.source !== "upload" && record.source !== "google-slides") throw new Error("Invalid deck source.");
  const name = compactText(record.name, 512);
  if (!name) throw new Error("Deck name is required.");
  if (!Number.isInteger(record.slideCount) || record.slideCount < 1 || record.slideCount > 10_000) {
    throw new Error("Invalid slide count.");
  }
  if (!Number.isSafeInteger(record.widthEmu) || record.widthEmu < 0 || !Number.isSafeInteger(record.heightEmu) || record.heightEmu < 0) {
    throw new Error("Invalid deck dimensions.");
  }
  if (!Array.isArray(record.slides) || record.slides.length !== record.slideCount) {
    throw new Error("Invalid slide data.");
  }
  const sourceUrl = normalizeSourceUrl(record.source, record.sourceUrl);
  const slides = record.slides.map((slide, index) => ({
    index: Number.isInteger(slide.index) ? slide.index : index + 1,
    texts: Array.isArray(slide.texts) ? slide.texts.map((text) => compactText(text, 20_000)).filter(Boolean) : [],
    shapeCount: safeCount(slide.shapeCount),
    textShapeCount: safeCount(slide.textShapeCount),
    imageCount: safeCount(slide.imageCount),
  }));
  const media = Array.isArray(record.media)
    ? record.media.slice(0, 10_000).map((item) => ({
        format: compactText(item.format, 32),
        bytes: safeCount(item.bytes),
        width: safeCount(item.width),
        height: safeCount(item.height),
      }))
    : [];
  return {
    deckFingerprint: record.deckFingerprint,
    name,
    source: record.source,
    ...(sourceUrl ? { sourceUrl } : {}),
    slideCount: record.slideCount,
    widthEmu: record.widthEmu,
    heightEmu: record.heightEmu,
    slides,
    media,
  };
}

function normalizeSourceUrl(source: DeckCaptureSource, value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (source !== "google-slides" || value.length > 8192) throw new Error("Invalid source URL.");
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["docs.google.com", "drive.google.com"].includes(url.hostname)) {
      throw new Error("Invalid source URL.");
    }
    return url.toString().slice(0, 8192);
  } catch {
    throw new Error("Invalid source URL.");
  }
}

function compactText(value: unknown, max: number): string {
  return typeof value === "string" ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function safeCount(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function dateIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function parseCursor(cursor: string | undefined): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  const split = cursor.indexOf("|");
  if (split < 1) return null;
  const createdAt = cursor.slice(0, split);
  const id = cursor.slice(split + 1);
  if (!Number.isFinite(Date.parse(createdAt)) || !id || id.length > 128) return null;
  return { createdAt, id };
}
