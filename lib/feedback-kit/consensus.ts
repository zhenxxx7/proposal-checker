import type { ConsensusConfig, KitRow } from "./types";

/**
 * Numeric timestamp for ordering. Stringifying a Date puts the weekday name
 * first ("Sat Jul 18..."), so lexicographic comparison ordered rows by
 * weekday instead of by time — ordering must always go through this.
 */
export function receivedAtMs(row: KitRow): number {
  if (row.received_at instanceof Date) return row.received_at.getTime();
  const parsed = Date.parse(String(row.received_at ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function rowIsNewer(candidate: KitRow, current: KitRow): boolean {
  const diff = receivedAtMs(candidate) - receivedAtMs(current);
  if (diff !== 0) return diff > 0;
  return candidate.finding_fingerprint > current.finding_fingerprint;
}

export function newestRow<T extends KitRow>(rows: readonly T[]): T | undefined {
  return [...rows].sort(
    (a, b) => receivedAtMs(b) - receivedAtMs(a) || b.finding_fingerprint.localeCompare(a.finding_fingerprint),
  )[0];
}

/** Latest accepted row per (deck, pattern), grouped by pattern. */
export function latestPerDeckAndPattern<T extends KitRow>(
  rows: readonly T[],
  accept: (row: T) => boolean = () => true,
): Map<string, T[]> {
  const latest = new Map<string, T>();
  for (const row of rows) {
    if (!accept(row)) continue;
    const key = `${row.deck_fingerprint}|${row.learning_key}`;
    const current = latest.get(key);
    if (!current || rowIsNewer(row, current)) latest.set(key, row);
  }
  const byPattern = new Map<string, T[]>();
  for (const row of latest.values()) {
    const group = byPattern.get(row.learning_key);
    if (group) group.push(row);
    else byPattern.set(row.learning_key, [row]);
  }
  return byPattern;
}

/**
 * Cross-deck consensus over one pattern's latest-per-deck rows: a rating
 * generalizes only when enough distinct decks agree strongly enough.
 */
export function resolvePatternRating(
  rows: readonly KitRow[],
  config: ConsensusConfig,
): "useful" | "not-useful" | null {
  if (rows.length < config.minDecks) return null;
  const rejected = rows.filter((row) => row.rating === "not-useful").length;
  const accepted = rows.length - rejected;
  if (rejected / rows.length >= config.agreement) return "not-useful";
  if (accepted / rows.length >= config.agreement) return "useful";
  return null;
}
