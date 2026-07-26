/**
 * Retention for captured analysis inputs, plus per-deck data deletion:
 *   npm run retention                                 # purge expired inputs
 *   npm run retention -- --dry-run                    # count only
 *   npm run retention -- --purge-deck deck-v1-<hex>   # client data deletion
 */
import { neon } from "@neondatabase/serverless";
import { loadEnvLocal } from "./lib/env.mjs";
import { countExpiredInputs, purgeDeck, purgeExpiredInputs } from "../lib/analysisInputs";

loadEnvLocal();

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const purgeDeckIndex = args.indexOf("--purge-deck");
const deckFingerprint = purgeDeckIndex >= 0 ? args[purgeDeckIndex + 1] : undefined;

async function main() {
if (!process.env.DATABASE_URL) {
  console.log("DATABASE_URL is not configured — nothing to purge.");
  process.exit(0);
}

if (deckFingerprint !== undefined) {
  if (!/^deck-v1-[a-f0-9]{16}$/.test(deckFingerprint)) {
    console.error("--purge-deck expects a deck-v1-<16 hex> fingerprint.");
    process.exit(1);
  }
  if (dryRun) {
    const sql = neon(process.env.DATABASE_URL);
    const [inputs] = (await sql.query(
      `SELECT COUNT(*)::int AS total FROM proposal_checker_analysis_inputs WHERE deck_fingerprint = $1`,
      [deckFingerprint],
    )) as { total: number }[];
    const [feedback] = (await sql.query(
      `SELECT COUNT(*)::int AS total FROM proposal_checker_feedback WHERE deck_fingerprint = $1`,
      [deckFingerprint],
    )) as { total: number }[];
    console.log(
      `dry-run: would delete ${inputs?.total ?? 0} captured input(s) and ${feedback?.total ?? 0} feedback row(s) for ${deckFingerprint}`,
    );
  } else {
    const removed = await purgeDeck(deckFingerprint);
    console.log(
      `deleted ${removed.inputs} captured input(s) and ${removed.feedback} feedback row(s) for ${deckFingerprint}`,
    );
  }
  process.exit(0);
}

if (dryRun) {
  console.log(`dry-run: ${await countExpiredInputs()} expired captured input(s) would be deleted`);
} else {
  console.log(`deleted ${await purgeExpiredInputs()} expired captured input(s)`);
}
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
