/**
 * Drives the admin review flow in a real browser against the dev server:
 *   node scripts/verify-admin.mjs <adminToken> [url]
 * Requires the dev server running with ADMIN_TOKEN=<adminToken> and a Neon
 * DATABASE_URL (shared feedback configured). Seeds one synthetic pending
 * feedback row, reviews it through the UI, checks both exports, and removes
 * the row again.
 */
import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { loadEnvLocal } from "./lib/env.mjs";

const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find(existsSync);

const adminToken = process.argv[2];
const url = process.argv[3] ?? "http://localhost:3000/";
if (!adminToken || !CHROME) {
  throw new Error("usage: node scripts/verify-admin.mjs <adminToken> [url]  (no browser found)");
}

let failures = 0;
const expect = (cond, msg) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures++;
};

const status = await (await fetch(new URL("/api/status", url))).json();
if (status.feedbackConfigured !== true) {
  console.log("\nSKIP  shared feedback is not configured (no DATABASE_URL) — admin queue cannot be exercised.");
  process.exit(0);
}

// ---- Seed one pending feedback row through the public API -----------------
const marker = `verify-admin-${Date.now()}`;
const record = {
  schemaVersion: 1,
  id: randomUUID(),
  fingerprint: `finding-v1-${marker}`,
  rating: "not-useful",
  createdAt: new Date().toISOString(),
  reason: "Synthetic row from verify-admin.",
  deck: { name: `${marker}.pptx`, slideCount: 3, fingerprint: "deck-v1-0123456789abcdef" },
  finding: {
    source: "ai-text",
    code: "ai.text",
    slide: 2,
    severity: "warn",
    category: "typo",
    title: `“${marker}”`,
    detail: `Synthetic finding ${marker} used to verify the review queue.`,
    quote: marker,
    suggestion: "original-suggestion",
  },
};
const seed = await fetch(new URL("/api/feedback", url), {
  method: "POST",
  headers: { "content-type": "application/json", origin: new URL(url).origin },
  body: JSON.stringify({ record }),
});
const seeded = await seed.json();
expect(seed.status === 201 && seeded.stored === true, `seeded one pending feedback row (HTTP ${seed.status})`);

const cleanup = async () => {
  loadEnvLocal();
  if (!process.env.DATABASE_URL) return;
  try {
    const sql = neon(process.env.DATABASE_URL);
    await sql.query(`DELETE FROM proposal_checker_feedback WHERE id = $1`, [record.id]);
  } catch (error) {
    console.log(`  info  cleanup skipped (${error.message})`);
  }
};

try {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--window-size=1400,1000"],
    defaultViewport: { width: 1400, height: 1000 },
  });
  const page = await browser.newPage();

  console.log("\n1. /admin redirects to the login page without a session");
  await page.goto(new URL("/admin", url).toString(), { waitUntil: "networkidle0" });
  expect(page.url().includes("/admin/login"), `landed on ${page.url()}`);
  expect((await page.$$("input[name=token]")).length === 1, "token form rendered");

  console.log("\n2. A wrong token is rejected without an oracle");
  await page.type("input[name=token]", "definitely-not-the-token");
  await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), page.click("button[type=submit]")]);
  expect(page.url().includes("/admin/login?error=1"), "redirected back to the login form");
  expect((await page.$$("[data-login-error]")).length === 1, "failure notice shown");

  console.log("\n3. The right token opens the review queue");
  await page.type("input[name=token]", adminToken);
  await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), page.click("button[type=submit]")]);
  expect(new URL(page.url()).pathname === "/admin", `landed on ${page.url()}`);
  await page.waitForSelector("[data-review-tabs]", { timeout: 10000 });
  const rowSelector = `[data-review-row="${record.id}"]`;
  expect((await page.$$(rowSelector)).length === 1, "seeded row visible in the pending queue");
  expect(
    (await page.$$(`${rowSelector} [data-needs-correction]`)).length === 1,
    "not-useful row without correction is flagged as untrainable",
  );

  console.log("\n4. Approving with an admin correction moves the row");
  await page.type(`${rowSelector} textarea[name=correction]`, "admin-corrected-suggestion");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle0" }),
    page.click(`${rowSelector} button[value=approved]`),
  ]);
  expect((await page.$$(rowSelector)).length === 0, "row left the pending queue");
  await page.goto(new URL("/admin?status=approved", url).toString(), { waitUntil: "networkidle0" });
  expect((await page.$$(rowSelector)).length === 1, "row appears in the approved tab");

  console.log("\n5. Exports stream valid JSONL containing the approved row");
  const exports = await page.evaluate(async () => {
    const read = async (format) => {
      const res = await fetch(`/api/admin/export?format=${format}`);
      return { status: res.status, text: await res.text() };
    };
    return { sft: await read("sft"), dpo: await read("dpo") };
  });
  for (const format of ["sft", "dpo"]) {
    const { status: httpStatus, text } = exports[format];
    expect(httpStatus === 200, `${format} export responds 200`);
    const lines = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const mine = lines.find((line) => line.metadata?.id === record.id);
    expect(!!mine, `${format} export contains the approved row (${lines.length} line(s) total)`);
    if (format === "sft" && mine) {
      const assistant = JSON.parse(mine.messages.at(-1).content);
      expect(
        assistant.findings?.[0]?.suggestion === "admin-corrected-suggestion",
        "sft assistant target carries the admin correction",
      );
      expect(mine.metadata.input_available === false, "sft metadata reports missing analysis input");
    }
    if (format === "dpo" && mine) {
      const preferred = JSON.parse(mine.preferred_output[0].content).findings[0].suggestion;
      const rejected = JSON.parse(mine.non_preferred_output[0].content).findings[0].suggestion;
      expect(preferred === "admin-corrected-suggestion", "dpo preferred output is the correction");
      expect(rejected === "original-suggestion", "dpo non-preferred output is the original AI answer");
    }
  }

  console.log("\n6. The export refuses anonymous callers");
  const anonExport = await fetch(new URL("/api/admin/export?format=sft", url));
  expect(anonExport.status === 401, `HTTP ${anonExport.status} without a session cookie`);
  const anonReview = await fetch(new URL("/api/admin/review", url), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: new URL(url).origin },
    body: `id=${record.id}&decision=rejected`,
    redirect: "manual",
  });
  expect(anonReview.status === 303, `review without a session bounces to login (HTTP ${anonReview.status})`);
  expect(
    (anonReview.headers.get("location") ?? "").includes("/admin/login"),
    "bounce target is the login page",
  );

  await browser.close();
} finally {
  await cleanup();
  console.log("  info  synthetic row removed");
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
