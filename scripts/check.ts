/**
 * Headless rule check — no browser, no AI, no API key.
 *   npm run check -- "path/to/deck.pptx" [--md report.md]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { parsePptx } from "../lib/pptx";
import { runRuleChecks } from "../lib/checks";
import { groupFindings, readiness } from "../lib/groups";
import { tally, toMarkdown } from "../lib/report";

// parsePptx targets the browser DOM; give Node an equivalent before it runs.
(globalThis as unknown as { DOMParser: unknown }).DOMParser = DOMParser;

const args = process.argv.slice(2);
const mdIndex = args.indexOf("--md");
const mdPath = mdIndex >= 0 ? args[mdIndex + 1] : null;
const files = args.filter((a, i) => i !== mdIndex && !(mdIndex >= 0 && i === mdIndex + 1));

if (!files.length) {
  console.error('usage: npm run check -- "deck.pptx" [--md report.md]');
  process.exit(1);
}

for (const file of files) {
  const t0 = Date.now();
  const buf = readFileSync(file);
  const deck = parsePptx(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  const parseMs = Date.now() - t0;

  const t1 = Date.now();
  const findings = runRuleChecks(deck);
  const checkMs = Date.now() - t1;

  const pics = deck.slides.flatMap((s) => s.shapes.filter((x) => x.kind === "pic"));
  const texts = deck.slides.flatMap((s) => s.shapes.filter((x) => x.kind === "text"));
  const c = tally(findings);

  console.log("=".repeat(78));
  console.log(file.split(/[\\/]/).pop());
  console.log(
    `  ${deck.slides.length} slides · ${pics.length} pictures · ${texts.length} text shapes · ${deck.media.size} media` +
      ` · parse ${parseMs}ms · checks ${checkMs}ms`,
  );
  console.log(`  ${c.error} blocking · ${c.warn} review · ${c.info} minor`);

  const STATE = { blocked: "⚠ Not ready to send", almost: "◑ Almost ready", ready: "✓ Ready to send" };
  console.log(`  ${STATE[readiness(findings)]}`);

  console.log("\n  what to fix, grouped");
  const icon = { error: "🔴", warn: "🟡", info: "🔵" } as const;
  for (const g of groupFindings(findings)) {
    const where = g.slides.length > 6 ? `${g.slides.length} slides` : `slide ${g.slides.join(", ")}`;
    console.log(`   ${icon[g.severity]} ${g.title}  (${where})`);
    if (g.why) console.log(`      ${g.why}`);
  }

  if (args.includes("--debug")) {
    const byTitle = new Map<string, number>();
    for (const f of findings) byTitle.set(f.title, (byTitle.get(f.title) ?? 0) + 1);
    console.log("  by rule:", Object.fromEntries([...byTitle].sort((a, b) => b[1] - a[1]).slice(0, 15)));
    for (const f of findings.filter((x) => x.title.includes("Same term") || x.title.includes("capitalisation")).slice(0, 15)) {
      console.log(`   · ${f.detail.slice(0, 110)}`);
    }

    console.log("\n  all findings:");
    for (const f of findings) {
      console.log(`   [${f.severity}] s${f.slide} ${f.category} · ${f.title}`);
      console.log(`      ${f.detail.slice(0, 150)}`);
    }
  }

  const noDims = [...deck.media.values()].filter((m) => m.format !== "svg" && (!m.width || !m.height));
  if (noDims.length) console.warn(`  ⚠ ${noDims.length} media files had unreadable headers`);

  console.log("\n  top findings");
  for (const f of findings.filter((x) => x.severity === "error").slice(0, 10)) {
    console.log(`   🔴 s${f.slide} ${f.category}: ${f.title}`);
    if (f.quote) console.log(`      ${JSON.stringify(f.quote.slice(0, 100))}`);
  }
  for (const f of findings.filter((x) => x.severity === "warn").slice(0, 6)) {
    console.log(`   🟡 s${f.slide} ${f.category}: ${f.title}`);
  }

  if (mdPath) {
    writeFileSync(mdPath, toMarkdown(file, deck.slides.length, findings), "utf8");
    console.log(`\n  report → ${mdPath}`);
  }
  console.log();
}
