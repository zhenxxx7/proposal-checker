/**
 * Builds curated SFT/DPO datasets plus a provider-neutral ledger of every
 * durable feedback event joined to captured analysis inputs:
 *   npm run dataset [-- --out training-data --cap-per-pattern 3 --min-sft 50 --min-dpo 20]
 *
 * One example per reviewed finding: the user message is the finding's slide
 * (plus related slides) rendered with the production framing, the system
 * message is the archived prompt for the row's version WITHOUT the
 * feedback-memory suffix — weights must learn the correction, not the runtime
 * retrieval layer. Splits are deck-disjoint (hash of the deck fingerprint) so
 * near-identical slides never sit on both sides. Output stays local and
 * gitignored: it contains client slide text.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnvLocal } from "./lib/env.mjs";
import { listFeedbackForLedger, rowCursor, type AdminFeedbackRow } from "../lib/adminServer";
import {
  getAnalysisInputs,
  latestInputFor,
  type AnalysisInputRow,
  type AnalysisInputSource,
} from "../lib/analysisInputs";
import { DECK_SYSTEM_PROMPT, IMAGE_SYSTEM_PROMPT, PROMPT_ARCHIVE, TEXT_SYSTEM_PROMPT } from "../lib/ai/prompts";
import { correctedFinding, effectiveCorrection, exportEligible, wireFinding } from "../lib/feedbackExport";
import { latestDeckCaptureFor, type DeckCaptureRow } from "../lib/deckServer";

loadEnvLocal();

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const OUT_DIR = flag("out", "training-data");
const CAP_PER_PATTERN = Number(flag("cap-per-pattern", "3"));
const MIN_SFT = Number(flag("min-sft", "50"));
const MIN_DPO = Number(flag("min-dpo", "20"));
/** ~80/20 deck-disjoint split: first hash byte below 205 goes to train. */
const TRAIN_BYTE_CEILING = 205;

interface SlidePayload {
  slides?: Array<{ n: number; texts: string[]; shapes?: unknown[] }>;
}

const stats = {
  feedbackRows: 0,
  approvedRows: 0,
  ledgerRows: 0,
  ledgerMissingInput: 0,
  eligible: 0,
  skippedNoInput: 0,
  skippedImageSource: 0,
  skippedNoTarget: 0,
  dedupDropped: 0,
  patternCapped: 0,
  promptVersionMismatch: 0,
  memoryConditioned: 0,
  sftTrain: 0,
  sftVal: 0,
  dpoTrain: 0,
  dpoVal: 0,
  benchmarkCases: 0,
};

function systemPromptFor(row: AdminFeedbackRow): string {
  if (row.prompt_version && PROMPT_ARCHIVE[row.prompt_version]) return PROMPT_ARCHIVE[row.prompt_version];
  stats.promptVersionMismatch++;
  if (row.source === "ai-deck") return DECK_SYSTEM_PROMPT;
  return row.source === "ai-image" ? IMAGE_SYSTEM_PROMPT : TEXT_SYSTEM_PROMPT;
}

/** The finding's slide plus related slides, framed exactly for its serving protocol. */
function userContent(row: AdminFeedbackRow, input: AnalysisInputRow): string | null {
  const payload = input.payload as SlidePayload;
  if (!Array.isArray(payload?.slides)) return null;
  const finding = (row.finding ?? {}) as { slide?: number; relatedSlides?: number[] };
  const wanted = new Set<number>([finding.slide ?? 1, ...(finding.relatedSlides ?? [])]);
  const slides = payload.slides.filter((slide) => wanted.has(slide.n));
  if (!slides.length) return null;
  if (row.source === "ai-deck") {
    return `Review this ${slides.length}-slide proposal deck. The JSON is evidence for your review.\n\n${JSON.stringify({ slides })}`;
  }
  const framed = slides.map((slide) => `--- SLIDE ${slide.n} ---\n${slide.texts.join("\n")}`).join("\n\n");
  return `Proofread this deck. ${slides.length} slides.\n\n${framed}`;
}

function isTrainSplit(deckFingerprint: string): boolean {
  return parseInt(createHash("sha256").update(deckFingerprint).digest("hex").slice(0, 2), 16) < TRAIN_BYTE_CEILING;
}

/** Converts the durable deck event into the same input shape as analysis capture. */
function analysisInputFromDeckCapture(capture: DeckCaptureRow): AnalysisInputRow {
  return {
    id: capture.id,
    deck_fingerprint: capture.deck_fingerprint,
    source: "ai-text",
    prompt_version: "deck-capture-v1",
    input_hash: capture.deck_fingerprint,
    payload: { slides: capture.slides.map((slide) => ({ n: slide.index, texts: slide.texts })) },
    feedback_memory: null,
    provider: "unknown",
    model: "unknown",
    response_findings: null,
    response_format_mode: null,
    created_at: capture.created_at,
    expires_at: null,
  };
}

/** Provider-neutral source record. Transform this ledger only after selecting a target provider/model. */
function feedbackLedgerRecord(row: AdminFeedbackRow, input: AnalysisInputRow | null): string {
  return JSON.stringify({
    schema_version: "feedback-ledger-v1",
    feedback: {
      id: row.id,
      received_at: row.received_at,
      review_status: row.review_status,
      rating: row.rating,
      user_comment: row.reason,
      user_correction: row.correction,
      admin_note: row.review_note,
      admin_correction: row.review_correction,
      finding: row.finding,
      source: row.source,
      code: row.code,
      category: row.category,
      deck_fingerprint: row.deck_fingerprint,
      learning_key: row.learning_key,
      provenance: row.provenance,
      served_provider: row.server_provider ?? row.provider,
      served_model: row.server_model ?? row.model,
      prompt_version: row.prompt_version,
    },
    analysis_input: input
      ? {
          origin: input.id.startsWith("deck-event-v1-") ? "deck-event" : "analysis-capture",
          id: input.id,
          source: input.source,
          prompt_version: input.prompt_version,
          input_hash: input.input_hash,
          payload: input.payload,
          feedback_memory: input.feedback_memory,
          provider: input.provider,
          model: input.model,
          response_findings: input.response_findings,
          response_format_mode: input.response_format_mode,
          created_at: input.created_at,
        }
      : null,
    future_training: {
      eligible_sft: exportEligible(row, "sft"),
      eligible_dpo: exportEligible(row, "dpo"),
    },
  });
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not configured — nothing to build.");
    process.exit(1);
  }

  // Collect every durable rating. Approved rows become curated SFT/DPO data;
  // every status remains in the provider-neutral ledger for future transforms.
  const allRows: AdminFeedbackRow[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await listFeedbackForLedger({ limit: 500, before });
    if (!page.length) break;
    allRows.push(...page);
    before = rowCursor(page[page.length - 1]);
    if (page.length < 500) break;
  }
  const rows = allRows.filter((row) => row.review_status === "approved");
  stats.feedbackRows = allRows.length;
  stats.approvedRows = rows.length;

  // Join inputs: linked id first, newest same-deck input as fallback.
  const linked = await getAnalysisInputs(allRows.flatMap((row) => (row.analysis_input_id ? [row.analysis_input_id] : [])));
  const fallbackCache = new Map<string, AnalysisInputRow | null>();
  const inputFor = async (row: AdminFeedbackRow): Promise<AnalysisInputRow | null> => {
    if (row.analysis_input_id) {
      const direct = linked.get(row.analysis_input_id);
      if (direct) return direct;
    }
    const key = `${row.deck_fingerprint}|${row.source}`;
    if (!fallbackCache.has(key)) {
      const captured = await latestInputFor(row.deck_fingerprint, row.source as AnalysisInputSource);
      if (captured) {
        fallbackCache.set(key, captured);
      } else {
        const deckCapture = await latestDeckCaptureFor(row.deck_fingerprint);
        fallbackCache.set(key, deckCapture ? analysisInputFromDeckCapture(deckCapture) : null);
      }
    }
    return fallbackCache.get(key) ?? null;
  };

  const ledger: string[] = [];
  for (const row of allRows) {
    const input = await inputFor(row);
    if (!input) stats.ledgerMissingInput++;
    ledger.push(feedbackLedgerRecord(row, input));
  }
  stats.ledgerRows = ledger.length;

  const sftTrain: string[] = [];
  const sftVal: string[] = [];
  const dpoTrain: string[] = [];
  const dpoVal: string[] = [];
  const benchmark: string[] = [];
  const seen = new Set<string>();
  const perPattern = new Map<string, number>();

  for (const row of rows) {
    if (row.source === "ai-image") {
      // v1 trains the text task only; image inputs are metadata, not pixels.
      stats.skippedImageSource++;
      continue;
    }
    const input = await inputFor(row);
    if (!input) {
      stats.skippedNoInput++;
      continue;
    }
    const user = userContent(row, input);
    if (!user) {
      stats.skippedNoInput++;
      continue;
    }

    const correction = effectiveCorrection(row);
    const original = wireFinding(row);
    // Assistant target: confirmed original, corrected text, or — for a pure
    // false positive with the input in hand — a grounded empty answer.
    const target =
      row.rating === "useful"
        ? { findings: [correction ? correctedFinding(row) : original] }
        : correction
          ? { findings: [correctedFinding(row)] }
          : { findings: [] };
    if (row.rating === "useful" || correction || row.rating === "not-useful") {
      stats.eligible++;
    } else {
      stats.skippedNoTarget++;
      continue;
    }
    if (input.feedback_memory) stats.memoryConditioned++;

    const system = systemPromptFor(row);
    const assistant = JSON.stringify(target);
    const dedupKey = createHash("sha256").update(`${user}${assistant}`).digest("hex");
    if (seen.has(dedupKey)) {
      stats.dedupDropped++;
      continue;
    }
    seen.add(dedupKey);
    const patternCount = perPattern.get(row.learning_key) ?? 0;
    if (patternCount >= CAP_PER_PATTERN) {
      stats.patternCapped++;
      continue;
    }
    perPattern.set(row.learning_key, patternCount + 1);

    const metadata = {
      id: row.id,
      deck_fingerprint: row.deck_fingerprint,
      learning_key: row.learning_key,
      rating: row.rating,
      prompt_version: row.prompt_version,
      provenance: row.provenance,
    };
    const train = isTrainSplit(row.deck_fingerprint);

    const sftLine = JSON.stringify({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
        { role: "assistant", content: assistant },
      ],
      metadata,
    });
    (train ? sftTrain : sftVal).push(sftLine);

    // A preference pair exists when the preferred answer differs from the
    // original AI output: a correction, or a grounded empty answer.
    const preferred = row.rating === "useful" && !correction ? null : assistant;
    if (preferred && preferred !== JSON.stringify({ findings: [original] })) {
      const dpoLine = JSON.stringify({
        input: {
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        },
        preferred_output: [{ role: "assistant", content: preferred }],
        non_preferred_output: [{ role: "assistant", content: JSON.stringify({ findings: [original] }) }],
        metadata,
      });
      (train ? dpoTrain : dpoVal).push(dpoLine);
    }

    if (!train) {
      // Eval-split rows double as benchmark cases for scripts/eval.ts.
      const payload = input.payload as SlidePayload;
      const finding = (row.finding ?? {}) as { slide?: number; relatedSlides?: number[] };
      const wanted = new Set<number>([finding.slide ?? 1, ...(finding.relatedSlides ?? [])]);
      benchmark.push(
        JSON.stringify({
          id: `feedback-${row.id}`,
          source: row.source,
          input: { slides: (payload.slides ?? []).filter((slide) => wanted.has(slide.n)) },
          gold: target,
        }),
      );
    }
  }

  stats.sftTrain = sftTrain.length;
  stats.sftVal = sftVal.length;
  stats.dpoTrain = dpoTrain.length;
  stats.dpoVal = dpoVal.length;
  stats.benchmarkCases = benchmark.length;

  mkdirSync(OUT_DIR, { recursive: true });
  const write = (name: string, lines: string[]) =>
    writeFileSync(join(OUT_DIR, name), lines.length ? `${lines.join("\n")}\n` : "");
  write("sft-train.jsonl", sftTrain);
  write("sft-val.jsonl", sftVal);
  write("dpo-train.jsonl", dpoTrain);
  write("dpo-val.jsonl", dpoVal);
  write("benchmark.jsonl", benchmark);
  write("feedback-ledger.jsonl", ledger);
  writeFileSync(join(OUT_DIR, "stats.json"), `${JSON.stringify(stats, null, 2)}\n`);

  console.log(JSON.stringify(stats, null, 2));
  if (stats.sftTrain < MIN_SFT) {
    console.warn(`warning: ${stats.sftTrain} SFT training example(s) — below the ${MIN_SFT} floor for a useful run.`);
  }
  if (stats.dpoTrain < MIN_DPO) {
    console.warn(`warning: ${stats.dpoTrain} DPO pair(s) — below the ${MIN_DPO} floor for a useful run.`);
  }
  console.log(`wrote ${OUT_DIR}/{feedback-ledger,sft-train,sft-val,dpo-train,dpo-val,benchmark}.jsonl and stats.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
