import type { Deck, Fill, Finding, Shape } from "./types";

export type FeedbackRating = "useful" | "not-useful";
export type FeedbackDelivery = "local" | "shared" | "syncing" | "error";

export interface FeedbackRecord {
  schemaVersion: 1;
  id: string;
  fingerprint: string;
  rating: FeedbackRating;
  createdAt: string;
  deck: {
    name: string;
    slideCount: number;
    fingerprint?: string;
  };
  finding: {
    source: "ai-text" | "ai-image";
    code: Finding["code"];
    slide: number;
    severity: Finding["severity"];
    category: Finding["category"];
    title: string;
    detail: string;
    quote?: string;
    suggestion?: string;
    shapeIds?: string[];
    relatedSlides?: number[];
  };
  model?: {
    provider?: string;
    name?: string;
  };
}

export interface FeedbackSelection {
  rating: FeedbackRating;
  delivery: FeedbackDelivery;
}

export type FeedbackSelections = Record<string, FeedbackSelection>;

const STORAGE_PREFIX = "proposal-checker:ai-feedback:v1:";
const FEEDBACK_SEVERITIES = new Set(["error", "warn", "info"]);
const FEEDBACK_CATEGORIES = new Set([
  "typo",
  "grammar",
  "spacing",
  "punctuation",
  "capitalization",
  "consistency",
  "placeholder",
  "resolution",
  "aspect",
  "alignment",
  "geometry",
  "image-text",
]);
type FingerprintFinding = Pick<
  Finding,
  | "source"
  | "code"
  | "slide"
  | "severity"
  | "category"
  | "title"
  | "detail"
  | "quote"
  | "suggestion"
  | "shapeIds"
  | "relatedSlides"
>;
type LearningFinding = Pick<
  Finding,
  "source" | "code" | "category" | "title" | "detail" | "quote" | "suggestion"
>;

export interface FeedbackLearningResult {
  findings: Finding[];
  skipped: number;
}

export interface FeedbackDeckIdentity {
  name: string;
  fingerprint: string;
}

/** A compact, content-free request sent to the shared feedback policy route. */
export interface FeedbackPolicyPattern {
  findingFingerprint: string;
  learningKey: string;
}

export interface FeedbackPolicyRequest {
  deckFingerprint: string;
  patterns: FeedbackPolicyPattern[];
}

export interface FeedbackPolicyResponse {
  configured: boolean;
  suppressedLearningKeys: string[];
  /** Latest shared rating for each exact finding rendered in this run. */
  selections: Record<string, FeedbackRating>;
}

export function isAiFinding(finding: Finding): finding is Finding & {
  source: "ai-text" | "ai-image";
} {
  return finding.source === "ai-text" || finding.source === "ai-image";
}

/**
 * IDs returned by an AI run are sequential and change between runs. This
 * fingerprint is derived from the finding itself, so feedback survives reloads
 * and maps to the same finding in both the Summary and Slides views.
 */
export function findingFingerprint(finding: FingerprintFinding): string {
  const canonical = JSON.stringify({
    source: finding.source,
    code: finding.code,
    slide: finding.slide,
    severity: finding.severity,
    category: finding.category,
    title: finding.title.trim(),
    detail: finding.detail.trim(),
    quote: finding.quote?.trim() ?? "",
    suggestion: finding.suggestion?.trim() ?? "",
    shapeIds: [...(finding.shapeIds ?? [])].sort(),
    relatedSlides: [...(finding.relatedSlides ?? [])].sort((a, b) => a - b),
  });
  return `finding-v1-${hash(canonical)}`;
}

/**
 * A deck-independent identity for a finding pattern. Unlike the UI
 * fingerprint, this deliberately excludes slide, shape, severity, and
 * location-specific detail when a quote is available. A rating can therefore
 * teach this browser about the same AI claim when it appears in another deck.
 */
export function feedbackLearningKey(finding: LearningFinding): string {
  const quote = normalizeLearningText(finding.quote ?? "");
  const canonical = JSON.stringify({
    source: finding.source,
    code: finding.code,
    category: finding.category,
    ...(quote
      ? {
          quote,
          suggestion: normalizeLearningText(finding.suggestion ?? ""),
        }
      : {
          title: normalizeLearningText(finding.title),
          suggestion: normalizeLearningText(finding.suggestion ?? ""),
        }),
  });
  return `feedback-rule-v1-${hash(canonical)}`;
}

/**
 * Content identity avoids treating unrelated files with the same filename as
 * one deck, and prevents renaming one deck from manufacturing cross-deck votes.
 */
export function createFeedbackDeckIdentity(name: string, deck: Deck): FeedbackDeckIdentity {
  const parts = [`size:${deck.widthEmu},${deck.heightEmu}`, `slides:${deck.slides.length}`];
  for (const slide of deck.slides) {
    parts.push(`slide:${slide.index}`, `background:${fillSignature(slide.background)}`);
    for (const shape of [...(slide.backgroundShapes ?? []), ...slide.shapes]) {
      parts.push(shapeSignature(shape, deck));
    }
  }
  return { name, fingerprint: `deck-v1-${hash(parts.join("\u001f"))}` };
}

export function createFeedbackRecord({
  finding,
  rating,
  deckName,
  deckFingerprint,
  slideCount,
  provider,
  model,
}: {
  finding: Finding & { source: "ai-text" | "ai-image" };
  rating: FeedbackRating;
  deckName: string;
  deckFingerprint: string;
  slideCount: number;
  provider?: string;
  model?: string;
}): FeedbackRecord {
  return {
    schemaVersion: 1,
    id: feedbackEventId(),
    fingerprint: findingFingerprint(finding),
    rating,
    createdAt: new Date().toISOString(),
    deck: { name: deckName, slideCount, fingerprint: deckFingerprint },
    finding: {
      source: finding.source,
      code: finding.code,
      slide: finding.slide,
      severity: finding.severity,
      category: finding.category,
      title: finding.title,
      detail: finding.detail,
      ...(finding.quote ? { quote: finding.quote } : {}),
      ...(finding.suggestion ? { suggestion: finding.suggestion } : {}),
      ...(finding.shapeIds?.length ? { shapeIds: finding.shapeIds } : {}),
      ...(finding.relatedSlides?.length ? { relatedSlides: finding.relatedSlides } : {}),
    },
    ...(provider || model
      ? {
          model: {
            ...(provider ? { provider } : {}),
            ...(model ? { name: model } : {}),
          },
        }
      : {}),
  };
}

export function loadFeedbackSelections(identity: FeedbackDeckIdentity): FeedbackSelections {
  if (typeof window === "undefined" || !identity.name) return {};
  try {
    const records = readStoredRecords(storageKey(identity.fingerprint))
      .filter((record) => recordMatchesIdentity(record, identity));
    return Object.fromEntries(
      records.map((record) => [
        record.fingerprint,
        { rating: record.rating, delivery: "local" as const },
      ]),
    );
  } catch {
    return {};
  }
}

/**
 * Apply the latest local choice for each learned pattern. Rule findings are
 * never affected. This is deterministic application-level learning: no model
 * weights, server state, or extra request is involved.
 */
export function applyFeedbackLearning(
  findings: readonly Finding[],
  records: readonly FeedbackRecord[],
  deck: FeedbackDeckIdentity,
): FeedbackLearningResult {
  const latestByDeckAndPattern = new Map<string, FeedbackRecord>();
  for (const record of records) {
    if (!isFeedbackRecord(record)) continue;
    const pattern = feedbackLearningKey(record.finding);
    const key = `${feedbackDeckKey(record.deck)}|${pattern}`;
    const current = latestByDeckAndPattern.get(key);
    if (!current || feedbackRecordIsNewer(record, current)) latestByDeckAndPattern.set(key, record);
  }

  const byPattern = new Map<string, FeedbackRecord[]>();
  for (const record of latestByDeckAndPattern.values()) {
    const key = feedbackLearningKey(record.finding);
    const patternRecords = byPattern.get(key);
    if (patternRecords) patternRecords.push(record);
    else byPattern.set(key, [record]);
  }

  const kept = findings.filter((finding) => {
    if (!isAiFinding(finding)) return true;
    const recordsForPattern = byPattern.get(feedbackLearningKey(finding)) ?? [];
    const sameDeck = recordsForPattern.find((record) => recordMatchesIdentity(record, deck));
    if (sameDeck) return sameDeck.rating !== "not-useful";

    // A single deck must not teach a broad browser-wide false-positive rule.
    // Cross-deck learning needs agreement from at least two distinct decks,
    // and very short labels are never generalized.
    const quote = normalizeLearningText(finding.quote ?? "");
    if (quote.length < 4 || recordsForPattern.length < 2) return true;
    const rejected = recordsForPattern.filter((record) => record.rating === "not-useful").length;
    return rejected / recordsForPattern.length < 0.8;
  });
  return { findings: kept, skipped: findings.length - kept.length };
}

/**
 * Builds the smallest useful payload for the permanent-memory policy lookup.
 * It contains fingerprints only; uploaded PPTX data and preview imagery never
 * leave the browser through this request.
 */
export function createFeedbackPolicyRequest(
  deck: FeedbackDeckIdentity,
  findings: readonly Finding[],
): FeedbackPolicyRequest {
  const seen = new Set<string>();
  const patterns: FeedbackPolicyPattern[] = [];
  for (const finding of findings) {
    if (!isAiFinding(finding)) continue;
    const findingFingerprintValue = findingFingerprint(finding);
    if (seen.has(findingFingerprintValue)) continue;
    seen.add(findingFingerprintValue);
    patterns.push({
      findingFingerprint: findingFingerprintValue,
      learningKey: feedbackLearningKey(finding),
    });
  }
  return { deckFingerprint: deck.fingerprint, patterns };
}

/** Applies a server-resolved policy while preserving every local rule finding. */
export function applySharedFeedbackPolicy(
  findings: readonly Finding[],
  suppressedLearningKeys: readonly string[],
): FeedbackLearningResult {
  const suppressed = new Set(suppressedLearningKeys);
  const kept = findings.filter(
    (finding) => !isAiFinding(finding) || !suppressed.has(feedbackLearningKey(finding)),
  );
  return { findings: kept, skipped: findings.length - kept.length };
}

export function isFeedbackPolicyRequest(value: unknown): value is FeedbackPolicyRequest {
  if (!isObject(value) || !shortString(value.deckFingerprint, 128)) return false;
  if (!Array.isArray(value.patterns) || value.patterns.length > 500) return false;
  const patternKeys = new Set<string>();
  for (const pattern of value.patterns) {
    if (!isObject(pattern)) return false;
    if (
      !shortString(pattern.findingFingerprint, 256) ||
      !shortString(pattern.learningKey, 256) ||
      !pattern.findingFingerprint.startsWith("finding-v1-") ||
      !pattern.learningKey.startsWith("feedback-rule-v1-")
    ) {
      return false;
    }
    if (patternKeys.has(pattern.findingFingerprint)) return false;
    patternKeys.add(pattern.findingFingerprint);
  }
  return true;
}

export function isFeedbackPolicyResponse(value: unknown): value is FeedbackPolicyResponse {
  if (!isObject(value) || typeof value.configured !== "boolean") return false;
  if (!Array.isArray(value.suppressedLearningKeys) || !isObject(value.selections)) return false;
  if (
    !value.suppressedLearningKeys.every(
      (key) => shortString(key, 256) && key.startsWith("feedback-rule-v1-"),
    )
  ) {
    return false;
  }
  return Object.entries(value.selections).every(
    ([fingerprint, rating]) =>
      shortString(fingerprint, 256) &&
      fingerprint.startsWith("finding-v1-") &&
      (rating === "useful" || rating === "not-useful"),
  );
}

export function clearStoredFeedbackLearning(): void {
  if (typeof window === "undefined") return;
  const keys: string[] = [];
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(STORAGE_PREFIX)) keys.push(key);
    }
  } catch {
    return;
  }
  for (const key of keys) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // A browser storage failure should not crash the UI.
    }
  }
}

export function storeFeedbackRecord(record: FeedbackRecord): boolean {
  if (typeof window === "undefined") return false;
  const key = storageKey(record.deck.fingerprint ?? record.deck.name);
  let records: FeedbackRecord[] = [];
  try {
    const raw = window.localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      records = parsed.filter(
        (item): item is FeedbackRecord =>
          isFeedbackRecord(item) && feedbackDeckKey(item.deck) === feedbackDeckKey(record.deck),
      );
    }
  } catch {
    // Replace corrupt local data with the new valid record.
  }
  const next = records.filter((item) => item.fingerprint !== record.fingerprint);
  next.push(record);
  try {
    window.localStorage.setItem(key, JSON.stringify(next.slice(-500)));
    return true;
  } catch {
    return false;
  }
}

export function isFeedbackRecord(value: unknown): value is FeedbackRecord {
  if (!isObject(value) || value.schemaVersion !== 1) return false;
  if (!shortString(value.id, 128) || !shortString(value.fingerprint, 256)) return false;
  if (value.rating !== "useful" && value.rating !== "not-useful") return false;
  if (!shortString(value.createdAt, 64) || !Number.isFinite(Date.parse(value.createdAt))) return false;

  const deck = value.deck;
  if (!isObject(deck) || !shortString(deck.name, 512)) return false;
  if (!Number.isInteger(deck.slideCount) || Number(deck.slideCount) < 1 || Number(deck.slideCount) > 10000) return false;
  if (deck.fingerprint !== undefined && !shortString(deck.fingerprint, 128)) return false;

  const finding = value.finding;
  if (!isObject(finding) || (finding.source !== "ai-text" && finding.source !== "ai-image")) return false;
  if (
    (finding.source === "ai-text" && finding.code !== "ai.text") ||
    (finding.source === "ai-image" && finding.code !== "ai.image")
  ) return false;
  if (!positiveInteger(finding.slide, Number(deck.slideCount))) return false;
  if (
    !shortString(finding.severity, 16) ||
    !FEEDBACK_SEVERITIES.has(finding.severity) ||
    !shortString(finding.category, 64) ||
    !FEEDBACK_CATEGORIES.has(finding.category)
  ) return false;
  if (!shortString(finding.title, 500) || !shortString(finding.detail, 8000)) return false;
  if (finding.quote !== undefined && !shortString(finding.quote, 4000, true)) return false;
  if (finding.suggestion !== undefined && !shortString(finding.suggestion, 4000, true)) return false;
  if (finding.shapeIds !== undefined && !shortStringArray(finding.shapeIds, 100, 256)) return false;
  if (
    finding.relatedSlides !== undefined &&
    !integerArray(finding.relatedSlides, 1000, Number(deck.slideCount))
  ) return false;

  const model = value.model;
  if (model !== undefined) {
    if (!isObject(model)) return false;
    if (model.provider !== undefined && !shortString(model.provider, 128, true)) return false;
    if (model.name !== undefined && !shortString(model.name, 256, true)) return false;
  }
  return true;
}

function storageKey(deckName: string): string {
  return `${STORAGE_PREFIX}${hash(deckName)}`;
}

function readStoredRecords(key: string): FeedbackRecord[] {
  const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? "[]");
  return Array.isArray(parsed) ? parsed.filter(isFeedbackRecord) : [];
}

export function loadStoredFeedbackRecords(): FeedbackRecord[] {
  if (typeof window === "undefined") return [];
  const records: FeedbackRecord[] = [];
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(STORAGE_PREFIX)) continue;
      try {
        const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? "[]");
        if (!Array.isArray(parsed)) continue;
        records.push(...parsed.filter(isFeedbackRecord));
      } catch {
        // One corrupt browser entry must not disable valid feedback.
      }
    }
  } catch {
    return [];
  }
  return records;
}

function feedbackDeckKey(deck: FeedbackRecord["deck"]): string {
  if (deck.fingerprint) return `content:${deck.fingerprint}`;
  return `name:${normalizeDeckName(deck.name)}`;
}

function recordMatchesIdentity(record: FeedbackRecord, identity: FeedbackDeckIdentity): boolean {
  return record.deck.fingerprint === identity.fingerprint;
}

function normalizeDeckName(deckName: string): string {
  return deckName.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function feedbackRecordIsNewer(candidate: FeedbackRecord, current: FeedbackRecord): boolean {
  const candidateTime = Date.parse(candidate.createdAt);
  const currentTime = Date.parse(current.createdAt);
  return candidateTime > currentTime || (candidateTime === currentTime && candidate.id > current.id);
}

function normalizeLearningText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

function fillSignature(fill: Fill | undefined): string {
  if (!fill) return "";
  if (fill.type === "solid") return `solid:${fill.color}`;
  if (fill.type === "gradient") return `gradient:${fill.css}`;
  return `image:${fill.media}:${fill.crop.l},${fill.crop.t},${fill.crop.r},${fill.crop.b}`;
}

function shapeSignature(shape: Shape, deck: Deck): string {
  const { x, y, w, h } = shape.rect;
  const common = `${shape.kind}:${shape.id}:${x},${y},${w},${h}`;
  if (shape.kind === "pic") {
    const media = deck.media.get(shape.media);
    return [
      common,
      shape.name,
      shape.descr ?? "",
      shape.rot,
      shape.flipH,
      shape.flipV,
      shape.media,
      `${shape.crop.l},${shape.crop.t},${shape.crop.r},${shape.crop.b}`,
      media ? `${media.bytes},${media.width},${media.height},${media.format}` : "",
    ].join(":");
  }
  if (shape.kind === "cxn") {
    return [
      common,
      shape.color,
      shape.width,
      shape.dash,
      shape.flipH,
      shape.flipV,
    ].join(":");
  }
  return [
    common,
    shape.name,
    shape.rot,
    shape.placeholder ?? "",
    fillSignature(shape.fill),
    shape.geom ?? "",
    shape.paragraphs.map((paragraph) => paragraph.text).join("\u001e"),
  ].join(":");
}

function feedbackEventId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `feedback-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function hash(input: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shortString(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= max && (allowEmpty || value.length > 0);
}

function positiveInteger(value: unknown, max: number): boolean {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= max;
}

function shortStringArray(value: unknown, maxItems: number, maxLength: number): value is string[] {
  return Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => shortString(item, maxLength, true));
}

function integerArray(value: unknown, maxItems: number, max: number): value is number[] {
  return Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => positiveInteger(item, max));
}
