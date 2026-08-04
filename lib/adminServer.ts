import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import type { FeedbackRating } from "./feedback";
import { ensureFeedbackSchema, sharedFeedbackConfigured } from "./feedbackServer";

const TABLE = "proposal_checker_feedback";

export type ReviewStatus = "pending" | "approved" | "rejected";
export type ReviewDecision = ReviewStatus;

export interface AdminFeedbackRow {
  id: string;
  finding_fingerprint: string;
  learning_key: string;
  deck_fingerprint: string;
  slide_count: number;
  rating: FeedbackRating;
  source: string;
  code: string;
  category: string;
  finding: unknown;
  correction: string | null;
  reason: string | null;
  review_status: ReviewStatus;
  review_note: string | null;
  review_correction: string | null;
  reviewed_by: string | null;
  reviewed_at: string | Date | null;
  prompt_version: string | null;
  server_provider: string | null;
  server_model: string | null;
  provider: string | null;
  model: string | null;
  provenance: string;
  analysis_input_id: string | null;
  created_at: string | Date;
  received_at: string | Date;
}

const ROW_COLUMNS = `
  id, finding_fingerprint, learning_key, deck_fingerprint, slide_count, rating,
  source, code, category, finding, correction, reason,
  review_status, review_note, review_correction, reviewed_by, reviewed_at,
  prompt_version, server_provider, server_model, provider, model, provenance,
  analysis_input_id, created_at, received_at
`;

let sql: NeonQueryFunction<false, false> | null = null;

function getSql(): NeonQueryFunction<false, false> {
  if (!process.env.DATABASE_URL) throw new Error("Shared feedback database is not configured.");
  if (!sql) sql = neon(process.env.DATABASE_URL);
  return sql;
}

export function adminQueueConfigured(): boolean {
  return sharedFeedbackConfigured();
}

/** Keyset cursor: `<received_at ISO>|<id>` of the last row on the page. */
export function rowCursor(row: AdminFeedbackRow): string {
  return `${receivedAtIso(row)}|${row.id}`;
}

function receivedAtIso(row: AdminFeedbackRow): string {
  return row.received_at instanceof Date ? row.received_at.toISOString() : String(row.received_at ?? "");
}

function parseCursor(cursor: string | undefined): { receivedAt: string; id: string } | null {
  if (!cursor) return null;
  const split = cursor.indexOf("|");
  if (split < 1) return null;
  const receivedAt = cursor.slice(0, split);
  const id = cursor.slice(split + 1);
  if (!Number.isFinite(Date.parse(receivedAt)) || !id || id.length > 128) return null;
  return { receivedAt, id };
}

export async function listFeedbackForReview({
  status,
  limit = 50,
  before,
}: {
  status: ReviewStatus;
  limit?: number;
  before?: string;
}): Promise<AdminFeedbackRow[]> {
  await ensureFeedbackSchema();
  const cursor = parseCursor(before);
  const params: unknown[] = [status, limit];
  let where = "review_status = $1";
  if (cursor) {
    where += " AND (received_at, id) < ($3::timestamptz, $4)";
    params.push(cursor.receivedAt, cursor.id);
  }
  return (await getSql().query(
    `SELECT ${ROW_COLUMNS} FROM ${TABLE} WHERE ${where} ORDER BY received_at DESC, id DESC LIMIT $2`,
    params,
  )) as AdminFeedbackRow[];
}

export async function listApprovedForExport({
  limit = 500,
  before,
}: {
  limit?: number;
  before?: string;
}): Promise<AdminFeedbackRow[]> {
  return listFeedbackForReview({ status: "approved", limit, before });
}

/** Complete durable feedback ledger for future provider-specific dataset transforms. */
export async function listFeedbackForLedger({
  limit = 500,
  before,
}: {
  limit?: number;
  before?: string;
} = {}): Promise<AdminFeedbackRow[]> {
  await ensureFeedbackSchema();
  const cursor = parseCursor(before);
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 1_000);
  const params: unknown[] = [safeLimit];
  let where = "TRUE";
  if (cursor) {
    where = "(received_at, id) < ($2::timestamptz, $3)";
    params.push(cursor.receivedAt, cursor.id);
  }
  return (await getSql().query(
    `SELECT ${ROW_COLUMNS} FROM ${TABLE} WHERE ${where} ORDER BY received_at DESC, id DESC LIMIT $1`,
    params,
  )) as AdminFeedbackRow[];
}

export async function listFeedbackForDecks(deckFingerprints: readonly string[]): Promise<AdminFeedbackRow[]> {
  if (!deckFingerprints.length) return [];
  await ensureFeedbackSchema();
  return (await getSql().query(
    `SELECT ${ROW_COLUMNS} FROM ${TABLE} WHERE deck_fingerprint = ANY($1::text[]) ORDER BY received_at DESC, id DESC LIMIT 10000`,
    [[...deckFingerprints]],
  )) as AdminFeedbackRow[];
}

export async function approvePendingFeedback(reviewer = "admin"): Promise<{ id: string; analysisInputId: string | null }[]> {
  await ensureFeedbackSchema();
  const rows = (await getSql().query(
    `
      UPDATE ${TABLE} SET
        review_status = 'approved',
        reviewed_by = $1,
        reviewed_at = NOW()
      WHERE review_status = 'pending'
      RETURNING id, analysis_input_id
    `,
    [reviewer],
  )) as { id: string; analysis_input_id: string | null }[];
  return rows.map((row) => ({ id: row.id, analysisInputId: row.analysis_input_id }));
}

export async function countByStatus(): Promise<Record<ReviewStatus, number>> {
  await ensureFeedbackSchema();
  const rows = (await getSql().query(
    `SELECT review_status, COUNT(*)::int AS total FROM ${TABLE} GROUP BY review_status`,
  )) as { review_status: ReviewStatus; total: number }[];
  const counts: Record<ReviewStatus, number> = { pending: 0, approved: 0, rejected: 0 };
  for (const row of rows) {
    if (row.review_status in counts) counts[row.review_status] = row.total;
  }
  return counts;
}

/** `found` is false when the id does not exist — the route maps that to 404. */
export async function reviewFeedback({
  id,
  decision,
  note,
  correction,
  reviewer = "admin",
}: {
  id: string;
  decision: ReviewDecision;
  note?: string;
  correction?: string;
  reviewer?: string;
}): Promise<{ found: boolean; analysisInputId: string | null }> {
  await ensureFeedbackSchema();
  const rows = (await getSql().query(
    `
      UPDATE ${TABLE} SET
        review_status = $2,
        review_note = NULLIF($3, ''),
        review_correction = COALESCE(NULLIF($4, ''), review_correction),
        reviewed_by = CASE WHEN $2 = 'pending' THEN NULL ELSE $5 END,
        reviewed_at = CASE WHEN $2 = 'pending' THEN NULL ELSE NOW() END
      WHERE id = $1
      RETURNING id, analysis_input_id
    `,
    [id, decision, note?.trim() ?? "", correction?.trim() ?? "", reviewer],
  )) as { id: string; analysis_input_id: string | null }[];
  return { found: rows.length > 0, analysisInputId: rows[0]?.analysis_input_id ?? null };
}

export interface ReviewGroup {
  learningKey: string;
  rows: AdminFeedbackRow[];
}

/** Pure grouping by cross-deck pattern, ordered by first appearance (newest first). */
export function groupFeedbackForReview(rows: readonly AdminFeedbackRow[]): ReviewGroup[] {
  const byKey = new Map<string, AdminFeedbackRow[]>();
  for (const row of rows) {
    const group = byKey.get(row.learning_key);
    if (group) group.push(row);
    else byKey.set(row.learning_key, [row]);
  }
  return [...byKey.entries()].map(([learningKey, groupRows]) => ({ learningKey, rows: groupRows }));
}
