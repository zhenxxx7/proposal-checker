/**
 * Drives the real UI in a real browser against a real .pptx.
 *   node scripts/verify-ui.mjs <deck.pptx> [url]
 * Requires the dev server to be running. If an AI provider is configured
 * (point AI_BASE_URL at scripts/mock-ai.mjs), the AI pass is exercised too.
 */
import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
import { loadEnvLocal } from "./lib/env.mjs";

const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find(existsSync);

const deck = process.argv[2];
const url = process.argv[3] ?? "http://localhost:3000/";
if (!deck || !CHROME) throw new Error("usage: node scripts/verify-ui.mjs <deck.pptx> [url]  (no browser found)");

let failures = 0;
const expect = (cond, msg) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const status = await (await fetch(new URL("/api/status", url))).json();
const sharedFeedbackConfigured = status.feedbackConfigured === true;
console.log(`\nprovider: ${status.label || "none"} · model: ${status.model || "-"} · configured: ${status.configured}`);

/**
 * In shared mode the ratings this script submits land in the real Neon
 * feedback table, and the mock's synthetic "Submitt" pattern would suppress
 * itself on the next run. Deleting exactly the mock-signature rows keeps the
 * suite repeatable without touching real reviewer feedback.
 */
const cleanupMockFeedback = async (label) => {
  if (!sharedFeedbackConfigured) return;
  loadEnvLocal();
  if (!process.env.DATABASE_URL) return;
  try {
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql.query(
      `DELETE FROM proposal_checker_feedback
       WHERE (source = 'ai-image' AND finding->>'quote' = 'Submitt' AND finding->>'suggestion' = 'Submit')
          OR (source = 'ai-text' AND finding->>'quote' = 'recieve' AND finding->>'suggestion' = 'receive')
       RETURNING id`,
    );
    if (rows.length) console.log(`  info  ${label}: removed ${rows.length} mock feedback row(s) from shared memory`);
  } catch (error) {
    console.log(`  info  ${label}: mock feedback cleanup skipped (${error.message})`);
  }
};
await cleanupMockFeedback("pre-run");

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--window-size=1600,1000"],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();

const consoleErrors = [];
let feedbackWrites = 0;
let feedbackPolicyRequests = 0;
let aiAnalysisRequests = 0;
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));
page.on("request", (request) => {
  const path = new URL(request.url()).pathname;
  if (path === "/api/feedback") feedbackWrites++;
  if (path === "/api/feedback/policy") feedbackPolicyRequests++;
  if (path === "/api/analyze-text" || path === "/api/analyze-image") aiAnalysisRequests++;
});

const headerText = () => page.$eval("header", (e) => e.innerText.replace(/\n/g, " "));

console.log("\n1. Load the app");
await page.goto(url, { waitUntil: "networkidle0" });
expect((await page.title()) === "Proposal Checker", `document title: "${await page.title()}"`);
expect((await page.$$("input[type=file]")).length === 1, "dropzone present");

const layout = await page.evaluate(() => {
  const m = document.querySelector("main");
  return {
    main: Math.round(m.getBoundingClientRect().width),
    vw: innerWidth,
    font: getComputedStyle(document.body).fontFamily,
    dark: document.documentElement.classList.contains("dark"),
  };
});
expect(layout.main >= layout.vw - 60, `main fills the viewport (${layout.main}px of ${layout.vw}px)`);
expect(/Geist/i.test(layout.font), `Geist font applied`);
console.log(`  info  initial theme: ${layout.dark ? "dark" : "light"}`);

console.log("\n2. Theme toggle");
const before = await page.evaluate(() => document.documentElement.classList.contains("dark"));
await page.$$eval("header button", (els) => els.find((e) => e.getAttribute("aria-label") === "Toggle theme")?.click());
await wait(300);
const after = await page.evaluate(() => ({
  dark: document.documentElement.classList.contains("dark"),
  stored: localStorage.getItem("theme"),
}));
expect(after.dark === !before, `theme flips (${before ? "dark" : "light"} -> ${after.dark ? "dark" : "light"})`);
expect(after.stored === (after.dark ? "dark" : "light"), `persisted to localStorage: ${after.stored}`);

// Hold the first AI request so the test can inspect the initial loading state.
// Local findings must remain hidden until this request is released and all
// analysis branches settle.
let heldInitialAiRequest;
let initialAiStarted;
if (status.configured) {
  let markInitialAiStarted;
  initialAiStarted = new Promise((resolve) => {
    markInitialAiStarted = resolve;
  });
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (!heldInitialAiRequest && (path === "/api/analyze-text" || path === "/api/analyze-image")) {
      heldInitialAiRequest = request;
      markInitialAiStarted();
      return;
    }
    void request.continue();
  });
}

console.log("\n3. Upload and run one combined analysis");
await (await page.$("input[type=file]")).uploadFile(deck);
if (status.configured) {
  const remoteWorkStarted = await Promise.race([
    initialAiStarted.then(() => true),
    page.waitForSelector("[data-readiness]", { timeout: 60000 }).then(() => false),
  ]);
  if (remoteWorkStarted) {
    await page.waitForSelector("[data-analysis-progress]", { timeout: 60000 });
    await wait(250);
    expect((await page.$$('[data-readiness]')).length === 0, "no local-only result is revealed while AI runs");
    expect((await page.$$('[data-stat]')).length === 0, "summary stays hidden until merged result is ready");
    await page.screenshot({ path: "scripts/__processing.png" });
    await heldInitialAiRequest.continue();
  }
}
await page.waitForSelector("[data-readiness]", { timeout: 240000 });
if (status.configured) {
  await page.waitForFunction(() => document.querySelector("header").innerText.includes("Re-run AI check"), {
    timeout: 240000,
  });
}
await wait(800);

console.log("\n4. Summary view");
const banner = await page.$eval("h2", (e) => e.textContent);
expect(/Not ready to send|Almost ready|Ready to send/.test(banner), `readiness banner: "${banner}"`);

const readStats = () => page.$$eval("[data-stat]", (els) => els.map((e) => e.textContent));
const stats = await readStats();
expect(stats.length === 3, `three stat tiles: ${stats.join(" / ")}`);

const cardTitles = () => page.$$eval("[data-group-title]", (els) => els.map((e) => e.textContent));
const cards = await cardTitles();
expect(cards.length >= 1 && cards.length <= 14, `${cards.length} group cards (not a wall of rows)`);
cards.forEach((c) => console.log(`        · ${c}`));

const aiCtl = await headerText();
expect(
  status.configured ? /Re-run AI check/.test(aiCtl) : /AI check needs a key/.test(aiCtl),
  status.configured ? "AI ran automatically with the local check" : "AI button disabled with a reason",
);
await page.screenshot({ path: "scripts/__summary.png" });

console.log("\n5. Click a finding -> jumps to the slide, marks its location");
expect((await page.$$("[data-finding]")).length > 0, "top group is expanded on arrival");
await (await page.$("[data-finding]")).click();
await wait(800);
expect((await page.$$("[data-stage]")).length === 1, "switched to slides view");
expect((await page.$$("[data-stage] [data-finding-marker]")).length >= 1, "finding marker shown without raising the shape");
await page.screenshot({ path: "scripts/__slides.png" });

console.log("\n6. Slide rail thumbnails render lazily");
const thumbs = (await page.$$("nav button")).length;
const mounted = await page.$$eval("nav button", (els) => els.filter((e) => e.querySelector("img, p")).length);
expect(thumbs > 0, `${thumbs} slide thumbs`);
expect(mounted < thumbs || thumbs < 12, `only ${mounted}/${thumbs} mounted (lazy)`);

console.log("\n7. Keyboard navigation");
const cap = () => page.$eval("[data-slide-caption]", (e) => e.textContent.trim().slice(0, 16));
const capBefore = await cap();
await page.keyboard.press("ArrowRight");
await wait(400);
expect(capBefore !== (await cap()), `ArrowRight advances slide (${capBefore} -> ${await cap()})`);

console.log("\n8. Search filters the list but never the verdict");
await page.$$eval("header button", (els) => els.find((e) => e.textContent === "summary")?.click());
await wait(400);
await page.type('input[placeholder="Search findings…"]', "blurry");
await wait(600);
expect((await cardTitles()).length <= 3, `search narrows to ${(await cardTitles()).length} group(s)`);
const banner2 = await page.$eval("h2", (e) => e.textContent);
const stats2 = await readStats();
expect(banner2 === banner, `verdict unchanged while searching`);
expect(stats2.join("/") === stats.join("/"), `stat tiles unchanged: ${stats2.join(" / ")}`);
await page.screenshot({ path: "scripts/__search.png" });

// Clear the search before the AI run. Select-all + Backspace through real key
// events, so React's onChange actually fires.
await page.focus('input[placeholder="Search findings…"]');
await page.keyboard.down("Control");
await page.keyboard.press("KeyA");
await page.keyboard.up("Control");
await page.keyboard.press("Backspace");
await wait(500);
expect((await cardTitles()).length === cards.length, `search cleared, ${cards.length} groups back`);

const findHeaderButton = async (text) => {
  const btns = await page.$$("header button");
  const pairs = await Promise.all(btns.map(async (b) => [(await b.evaluate((e) => e.textContent)) ?? "", b]));
  return pairs.find(([t]) => t.includes(text))?.[1];
};

if (status.configured) {
  console.log("\n9. Cancel mid-run keeps partial results");
  await (await findHeaderButton("Re-run AI check")).click();
  await page.waitForFunction(() => document.querySelector("header").innerText.includes("Cancel"), {
    timeout: 60000,
  });
  const cancel = await findHeaderButton("Cancel");
  expect(!!cancel, "Cancel button appears while running");
  await cancel.click();
  await page.waitForFunction(() => !document.querySelector("header").innerText.includes("Cancel"), {
    timeout: 60000,
  });
  await wait(500);
  const partial = await readStats();
  expect(partial.join("/") !== stats.join("/"), `partial findings kept after cancel: ${partial.join(" / ")}`);
  const reRun = await findHeaderButton("Re-run AI check");
  expect(!reRun, "cancelled run is not marked complete");
  expect(consoleErrors.length === 0, "cancel produced no console errors");

  console.log("\n10. AI deep check, full run (real request path, mock endpoint)");
  const aiBtn = await findHeaderButton("Deep check with AI");
  expect(!!aiBtn, "AI button found");
  await aiBtn.click();

  await page.waitForFunction(() => document.querySelector("header").innerText.includes("Re-run AI check"), {
    timeout: 240000,
  });
  await wait(800);

  const afterAi = await cardTitles();
  const aiGroups = afterAi.filter((t) => /mockup image|proofreading note/i.test(t));
  expect(aiGroups.length >= 1, `AI groups appeared: ${aiGroups.join(" | ") || "none"}`);

  // Open the group only when it is collapsed; it can already be the top group.
  await page.$eval("[data-group='in-image']", (group) => {
    if (!group.querySelector("[data-finding]")) group.querySelector("button")?.click();
  });
  await wait(400);
  const shown = await page.$eval("[data-group='in-image']", (e) => e.innerText);
  expect(shown.includes("Submitt"), "in-image typo 'Submitt' rendered");
  expect(shown.includes("Submit"), "suggested fix 'Submit' rendered");
  expect(/slide \d+/.test(shown), "in-image finding is attributed to a slide");

  const stats3 = await readStats();
  expect(stats3.join("/") !== partial.join("/"), `full AI results restored: ${partial.join("/")} -> ${stats3.join("/")}`);

  console.log("\n11. AI feedback stays structured and synchronized");
  expect((await page.$$("[data-finding] textarea")).length === 0, "AI feedback has no free-text field");
  const rating = await page.$("[data-group='in-image'] [data-feedback-rating]");
  expect(!!rating, "AI finding exposes the usefulness dropdown");
  if (!rating) throw new Error("AI usefulness dropdown was not rendered.");
  await rating.select("not-useful");
  await page.waitForFunction(
    () => {
      const select = document.querySelector("[data-group='in-image'] [data-feedback-rating]");
      const status = select?.closest("[data-finding]")?.querySelector("[data-feedback-status]");
      return select?.value === "not-useful" && status?.getAttribute("data-feedback-status") !== "syncing";
    },
    { timeout: 10000 },
  );
  const feedbackState = await rating.evaluate((select) => ({
    value: select.value,
    status: select.closest("[data-finding]")?.querySelector("[data-feedback-status]")?.textContent,
    stored: Object.keys(localStorage).some((key) => key.startsWith("proposal-checker:ai-feedback:v1:")),
  }));
  expect(feedbackState.value === "not-useful", "Not useful selection applied");
  const expectedFeedbackStatus = sharedFeedbackConfigured ? "Shared memory" : "Learned locally";
  expect(feedbackState.status?.trim() === expectedFeedbackStatus, `rating persisted (${feedbackState.status})`);
  expect(
    sharedFeedbackConfigured ? !feedbackState.stored : feedbackState.stored,
    sharedFeedbackConfigured
      ? "shared rating is not duplicated into browser storage"
      : "rating written to browser storage",
  );
  expect(
    feedbackWrites === (sharedFeedbackConfigured ? 1 : 0),
    sharedFeedbackConfigured ? "rating writes through /api/feedback" : "local fallback skips /api/feedback write",
  );
  expect(feedbackPolicyRequests >= 1, "AI run checks the shared feedback policy route");

  console.log("\n11b. Correction details create one more structured write");
  const detailsToggle = await page.$("[data-group='in-image'] [data-feedback-details-toggle]");
  expect(!!detailsToggle, "details toggle appears after a rating");
  if (!detailsToggle) throw new Error("Feedback details toggle was not rendered.");
  await detailsToggle.click();
  const correctionField = await page.$("[data-group='in-image'] [data-feedback-correction]");
  expect(!!correctionField, "correction textarea appears when details are expanded");
  if (!correctionField) throw new Error("Correction textarea was not rendered.");
  await correctionField.type("Submit");
  await page.type("[data-group='in-image'] [data-feedback-reason]", "Button label is a typo.");
  await page.click("[data-group='in-image'] [data-feedback-details-save]");
  await page.waitForFunction(
    () => {
      const select = document.querySelector("[data-group='in-image'] [data-feedback-rating]");
      const status = select?.closest("[data-finding]")?.querySelector("[data-feedback-status]");
      return status?.getAttribute("data-feedback-status") !== "syncing";
    },
    { timeout: 10000 },
  );
  expect(
    feedbackWrites === (sharedFeedbackConfigured ? 2 : 0),
    sharedFeedbackConfigured
      ? "correction details write through /api/feedback"
      : "local mode saves details without a network write",
  );
  await detailsToggle.click();

  await rating.evaluate((select) => select.closest("[data-finding]")?.click());
  await page.waitForSelector("[data-stage]", { timeout: 10000 });
  const slideRating = await page.$eval("[data-stage] + aside [data-feedback-rating]", (select) => select.value);
  expect(slideRating === "not-useful", "same rating appears in Slides view");

  await (await findHeaderButton("summary")).click();
  await wait(400);
  await page.screenshot({ path: "scripts/__ai.png" });

  console.log("\n12. Browser-local feedback changes the next run and can be reset");
  const reRunWithLearning = await findHeaderButton("Re-run AI check");
  expect(!!reRunWithLearning, "re-run button available for learned filtering");
  if (!reRunWithLearning) throw new Error("Re-run AI check button was not rendered.");
  await reRunWithLearning.click();
  await page.waitForFunction(() => document.querySelector("header").innerText.includes("Cancel"), {
    timeout: 60000,
  });
  await page.waitForFunction(
    () => {
      const text = document.querySelector("header").innerText;
      return !text.includes("Cancel") && text.includes("Re-run AI check");
    },
    { timeout: 240000 },
  );
  const learningSelector = sharedFeedbackConfigured ? "[data-shared-learning]" : "[data-local-learning]";
  await page.waitForSelector(learningSelector, { timeout: 10000 });
  await wait(800);

  const learnedStats = await readStats();
  const statTotal = (values) =>
    values.reduce((total, value) => total + Number(value.match(/\d+/)?.[0] ?? 0), 0);
  expect(
    statTotal(learnedStats) < statTotal(stats3),
    `local learning hides one or more findings: ${stats3.join("/")} -> ${learnedStats.join("/")}`,
  );
  const learningNotice = await page.$eval(learningSelector, (e) => e.innerText);
  expect(/hid|hidden/i.test(learningNotice), `learning notice shown: "${learningNotice.replace(/\n/g, " ")}"`);
  expect(
    feedbackWrites === (sharedFeedbackConfigured ? 2 : 0),
    "learned re-run does not create another feedback write",
  );
  expect(feedbackPolicyRequests >= 2, "learned re-run checks permanent-memory policy again");

  if (!sharedFeedbackConfigured) {
    const aiRequestsBeforeReset = aiAnalysisRequests;
    const resetLearning = await page.$eval("[data-local-learning] button", (button) => {
      const isReset = button.textContent?.includes("Reset local learning");
      if (isReset) button.click();
      return isReset;
    });
    expect(resetLearning, "Reset local learning button found and clicked");
    await page.waitForFunction(() => !document.querySelector("[data-local-learning]"), {
      timeout: 10000,
    });
    await wait(400);

    const resetState = await page.evaluate(() => ({
      feedbackKeys: Object.keys(localStorage).filter((key) =>
        key.startsWith("proposal-checker:ai-feedback:v1:"),
      ),
    }));
    const restoredStats = await readStats();
    expect(resetState.feedbackKeys.length === 0, "reset clears browser feedback records");
    expect(restoredStats.join("/") === stats3.join("/"), `reset restores exact findings: ${restoredStats.join(" / ")}`);
    expect(aiAnalysisRequests === aiRequestsBeforeReset, "reset restores results without another AI request");
  } else {
    expect((await page.$$("[data-shared-learning] button")).length === 0, "shared memory is not erased by the local reset control");
  }
} else {
  console.log("\n9. AI deep check — skipped (no provider configured)");
}

console.log(`\n  console errors: ${consoleErrors.length}`);
consoleErrors.slice(0, 6).forEach((e) => console.log(`    ! ${e.slice(0, 160)}`));
expect(consoleErrors.length === 0, "no console errors");

await browser.close();
await cleanupMockFeedback("post-run");
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
