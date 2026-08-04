import { createHash } from "node:crypto";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { purgeDeckCaptures } from "./deckServer";

/**
 * Captures the exact model input of an analysis so an approved feedback row
 * can later be reconstructed into a training pair — without input, feedback
 * stores only the output half. Strictly opt-in: TRAINING_CAPTURE must be
 * "true", otherwise exact model inputs are not stored. Deck event capture is
 * separate and stores sanitized slide text/metadata when Neon is configured;
 * raw PPTX bytes and image pixels remain ephemeral. Captured rows expire after
 * TRAINING_CAPTURE_TTL_DAYS unless an admin approval pins them.
 */

const TABLE = "proposal_checker_analysis_inputs";
const MAX_PAYLOAD_CHARS = 200_000;

export type AnalysisInputSource = "ai-text" | "ai-image";

export interface AnalysisInputCapture {
  deckFingerprint: string;
  source: AnalysisInputSource;
  promptVersion: string;
  /** ai-text: the exact {slides} block sent to the model; ai-image: metadata only, never bytes. */
  payload: unknown;
  /** Feedback-memory examples that conditioned this response, if any. */
  feedbackMemory: unknown;
  provider: string;
  model: string;
  responseFindings: unknown;
  responseFormatMode: string;
}

export function trainingCaptureEnabled(): boolean {
  return process.env.TRAINING_CAPTURE === "true" && Boolean(process.env.DATABASE_URL);
}

function ttlDays(): number {
  const raw = Number(process.env.TRAINING_CAPTURE_TTL_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : 90;
}

let sql: NeonQueryFunction<false, false> | null = null;
let schemaReady: Promise<void> | null = null;

function getSql(): NeonQueryFunction<false, false> {
  if (!process.env.DATABASE_URL) throw new Error("Analysis input database is not configured.");
  if (!sql) sql = neon(process.env.DATABASE_URL);
  return sql;
}

async function ensureSchema(): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const db = getSql();
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id TEXT PRIMARY KEY,
        deck_fingerprint TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('ai-text', 'ai-image')),
        prompt_version TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        payload JSONB NOT NULL,
        payload_bytes INTEGER NOT NULL,
        feedback_memory JSONB,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        response_findings JSONB,
        response_format_mode TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ
      )
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS pc_analysis_inputs_deck_idx
      ON ${TABLE} (deck_fingerprint, source, created_at DESC)
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS pc_analysis_inputs_expiry_idx
      ON ${TABLE} (expires_at) WHERE expires_at IS NOT NULL
    `);
  })().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

/** Deterministic id: re-analyzing an unchanged deck writes nothing new. */
export function analysisInputId(
  deckFingerprint: string,
  source: AnalysisInputSource,
  promptVersion: string,
  inputHash: string,
): string {
  return `input-v1-${createHash("sha256")
    .update(`${deckFingerprint}|${source}|${promptVersion}|${inputHash}`)
    .digest("hex")
    .slice(0, 32)}`;
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Persists one analysis input. Never throws — a capture failure must not fail
 * the analysis — and returns null when capture is off or the payload is
 * oversized, so callers can pass the result straight to the response.
 */
export async function captureAnalysisInput(capture: AnalysisInputCapture): Promise<{ id: string } | null> {
  if (!trainingCaptureEnabled()) return null;
  try {
    const payloadJson = JSON.stringify(capture.payload);
    if (payloadJson.length > MAX_PAYLOAD_CHARS) return null;
    const inputHash = sha256Hex(payloadJson);
    const id = analysisInputId(capture.deckFingerprint, capture.source, capture.promptVersion, inputHash);
    await ensureSchema();
    await getSql().query(
      `
        INSERT INTO ${TABLE} (
          id, deck_fingerprint, source, prompt_version, input_hash,
          payload, payload_bytes, feedback_memory, provider, model,
          response_findings, response_format_mode, expires_at
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6::jsonb, $7, $8::jsonb, $9, $10,
          $11::jsonb, $12, NOW() + make_interval(days => $13)
        )
        ON CONFLICT (id) DO NOTHING
      `,
      [
        id,
        capture.deckFingerprint,
        capture.source,
        capture.promptVersion,
        inputHash,
        payloadJson,
        payloadJson.length,
        capture.feedbackMemory ? JSON.stringify(capture.feedbackMemory) : null,
        capture.provider,
        capture.model,
        capture.responseFindings ? JSON.stringify(capture.responseFindings) : null,
        capture.responseFormatMode,
        ttlDays(),
      ],
    );
    // Opportunistic retention so expired inputs age out without a cron.
    if (Math.random() < 0.05) void purgeExpiredInputs().catch(() => {});
    return { id };
  } catch (error) {
    console.error("Analysis input capture failed", error);
    return null;
  }
}

/** Approved training evidence is retained; everything else ages out. */
export async function pinAnalysisInput(id: string): Promise<void> {
  await ensureSchema();
  await getSql().query(`UPDATE ${TABLE} SET expires_at = NULL WHERE id = $1`, [id]);
}

export async function purgeExpiredInputs(): Promise<number> {
  await ensureSchema();
  const rows = (await getSql().query(
    `DELETE FROM ${TABLE} WHERE expires_at IS NOT NULL AND expires_at < NOW() RETURNING id`,
  )) as { id: string }[];
  return rows.length;
}

export async function countExpiredInputs(): Promise<number> {
  await ensureSchema();
  const rows = (await getSql().query(
    `SELECT COUNT(*)::int AS total FROM ${TABLE} WHERE expires_at IS NOT NULL AND expires_at < NOW()`,
  )) as { total: number }[];
  return rows[0]?.total ?? 0;
}

/** Client data-deletion: removes a deck's captured inputs AND feedback rows. */
export async function purgeDeck(deckFingerprint: string): Promise<{ inputs: number; feedback: number; decks: number }> {
  await ensureSchema();
  const db = getSql();
  const inputs = (await db.query(`DELETE FROM ${TABLE} WHERE deck_fingerprint = $1 RETURNING id`, [
    deckFingerprint,
  ])) as { id: string }[];
  const feedback = (await db.query(
    `DELETE FROM proposal_checker_feedback WHERE deck_fingerprint = $1 RETURNING id`,
    [deckFingerprint],
  )) as { id: string }[];
  const decks = await purgeDeckCaptures(deckFingerprint);
  return { inputs: inputs.length, feedback: feedback.length, decks };
}

export interface AnalysisInputRow {
  id: string;
  deck_fingerprint: string;
  source: AnalysisInputSource;
  prompt_version: string;
  input_hash: string;
  payload: unknown;
  feedback_memory: unknown;
  provider: string;
  model: string;
  response_findings: unknown;
  response_format_mode: string | null;
  created_at: string | Date;
  expires_at: string | Date | null;
}

export async function getAnalysisInput(id: string): Promise<AnalysisInputRow | null> {
  await ensureSchema();
  const rows = (await getSql().query(`SELECT * FROM ${TABLE} WHERE id = $1`, [id])) as AnalysisInputRow[];
  return rows[0] ?? null;
}

export async function getAnalysisInputs(ids: readonly string[]): Promise<Map<string, AnalysisInputRow>> {
  if (!ids.length) return new Map();
  await ensureSchema();
  const rows = (await getSql().query(`SELECT * FROM ${TABLE} WHERE id = ANY($1::text[])`, [
    [...ids],
  ])) as AnalysisInputRow[];
  return new Map(rows.map((row) => [row.id, row]));
}

/** Fallback join for feedback rows recorded before input linking existed. */
export async function latestInputFor(
  deckFingerprint: string,
  source: AnalysisInputSource,
): Promise<AnalysisInputRow | null> {
  await ensureSchema();
  const rows = (await getSql().query(
    `SELECT * FROM ${TABLE} WHERE deck_fingerprint = $1 AND source = $2 ORDER BY created_at DESC LIMIT 1`,
    [deckFingerprint, source],
  )) as AnalysisInputRow[];
  return rows[0] ?? null;
}
