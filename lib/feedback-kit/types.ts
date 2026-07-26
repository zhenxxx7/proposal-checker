/**
 * feedback-kit: the reusable, payload-agnostic core of the feedback-learning
 * pipeline. It sees only identity strings, ratings, and timestamps — the app
 * supplies fingerprint functions and projections, and `payload` flows through
 * opaquely. Kept dependency-free so a future project can lift this directory
 * into a package by adding table names and fingerprints of its own.
 */

export interface KitRow {
  finding_fingerprint: string;
  deck_fingerprint: string;
  learning_key: string;
  rating: string;
  received_at?: string | Date;
}

export interface ConsensusConfig {
  /** Distinct decks that must agree before a pattern generalizes. */
  minDecks: number;
  /** Agreement ratio required among those decks. */
  agreement: number;
}

export const DEFAULT_CONSENSUS: ConsensusConfig = { minDecks: 2, agreement: 0.8 };
