import { IMAGE_SYSTEM_PROMPT, PROMPT_ARCHIVE, TEXT_SYSTEM_PROMPT } from "./ai/prompts";
import type { AdminFeedbackRow } from "./adminServer";

/**
 * Pure serializers from approved feedback rows to training-ready JSONL
 * records. The user message stays empty until analysis-input capture links a
 * captured input to the row — `metadata.input_available` flips then, with no
 * shape change downstream tooling would have to absorb.
 */

export type ExportFormat = "sft" | "dpo";

export function isExportFormat(value: unknown): value is ExportFormat {
  return value === "sft" || value === "dpo";
}

/** The admin-edited text wins over the reviewer's original correction. */
export function effectiveCorrection(row: Pick<AdminFeedbackRow, "correction" | "review_correction">): string | null {
  const value = row.review_correction?.trim() || row.correction?.trim();
  return value || null;
}

/**
 * Which approved rows can become a training example:
 * - SFT needs a trustworthy assistant target — the original finding when the
 *   reviewer confirmed it, or the corrected text.
 * - DPO needs a preference pair, which only exists once a correction does.
 * A "not useful" without a correction still powers suppression, but exporting
 * it would require fabricating an assistant answer we never saw.
 */
export function exportEligible(row: AdminFeedbackRow, format: ExportFormat): boolean {
  if (row.review_status !== "approved") return false;
  if (format === "dpo") return Boolean(effectiveCorrection(row));
  return row.rating === "useful" || Boolean(effectiveCorrection(row));
}

export interface WireFinding {
  slide: number;
  severity: string;
  category: string;
  quote: string;
  suggestion: string;
  detail: string;
}

/** Project the stored finding back onto the model's production output shape. */
export function wireFinding(row: AdminFeedbackRow): WireFinding {
  const finding = (row.finding ?? {}) as Record<string, unknown>;
  return {
    slide: typeof finding.slide === "number" ? finding.slide : 1,
    severity: typeof finding.severity === "string" ? finding.severity : "warn",
    category: typeof finding.category === "string" ? finding.category : row.category,
    quote: typeof finding.quote === "string" ? finding.quote : "",
    suggestion: typeof finding.suggestion === "string" ? finding.suggestion : "",
    detail: typeof finding.detail === "string" ? finding.detail : "",
  };
}

export function correctedFinding(row: AdminFeedbackRow): WireFinding {
  const original = wireFinding(row);
  const correction = effectiveCorrection(row);
  return correction ? { ...original, suggestion: correction } : original;
}

function systemPromptFor(row: AdminFeedbackRow): string {
  if (row.prompt_version && PROMPT_ARCHIVE[row.prompt_version]) return PROMPT_ARCHIVE[row.prompt_version];
  return row.source === "ai-image" ? IMAGE_SYSTEM_PROMPT : TEXT_SYSTEM_PROMPT;
}

function assistantContent(finding: WireFinding): string {
  return JSON.stringify({ findings: [finding] });
}

function metadata(row: AdminFeedbackRow) {
  return {
    id: row.id,
    learning_key: row.learning_key,
    deck_fingerprint: row.deck_fingerprint,
    rating: row.rating,
    source: row.source,
    prompt_version: row.prompt_version,
    provider: row.server_provider ?? row.provider,
    model: row.server_model ?? row.model,
    provenance: row.provenance,
    reviewed_at: row.reviewed_at instanceof Date ? row.reviewed_at.toISOString() : row.reviewed_at,
    input_available: Boolean(row.analysis_input_id),
  };
}

/** OpenAI supervised chat-format record. */
export function sftRecord(row: AdminFeedbackRow) {
  return {
    messages: [
      { role: "system", content: systemPromptFor(row) },
      { role: "user", content: "" },
      { role: "assistant", content: assistantContent(correctedFinding(row)) },
    ],
    metadata: metadata(row),
  };
}

/** OpenAI preference (DPO) record: corrected beats the original AI answer. */
export function dpoRecord(row: AdminFeedbackRow) {
  return {
    input: {
      messages: [
        { role: "system", content: systemPromptFor(row) },
        { role: "user", content: "" },
      ],
    },
    preferred_output: [{ role: "assistant", content: assistantContent(correctedFinding(row)) }],
    non_preferred_output: [{ role: "assistant", content: assistantContent(wireFinding(row)) }],
    metadata: metadata(row),
  };
}
