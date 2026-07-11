/**
 * Imports a public Google Slides share link through the real UI.
 *   node scripts/verify-google-slides.mjs <share-url> [app-url]
 */
import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";

const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find(existsSync);

const args = process.argv.slice(2);
const mobile = args.includes("--mobile");
const constrained = args.includes("--constrained");
const positional = args.filter((arg) => !arg.startsWith("--"));
const shareUrl = positional[0];
const appUrl = positional[1] ?? "http://localhost:3000/";
if (!shareUrl || !CHROME) {
  throw new Error(
    "usage: node scripts/verify-google-slides.mjs <share-url> [app-url] [--mobile] [--constrained]  (no browser found)",
  );
}

const viewport = mobile || constrained ? { width: 412, height: 915 } : { width: 1600, height: 1000 };

let failures = 0;
const expect = (condition, message) => {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${message}`);
  if (!condition) failures++;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const status = await (await fetch(new URL("/api/status", appUrl))).json();

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: [
    "--no-sandbox",
    `--window-size=${viewport.width},${viewport.height}`,
    ...(constrained ? ["--js-flags=--max-old-space-size=256"] : []),
  ],
  defaultViewport: viewport,
});
const page = await browser.newPage();
const consoleErrors = [];
const failedRequests = [];
page.on("console", (message) => message.type() === "error" && consoleErrors.push(message.text()));
page.on("pageerror", (error) => consoleErrors.push(String(error)));
page.on("requestfailed", (request) => failedRequests.push(`${request.url()} · ${request.failure()?.errorText ?? "failed"}`));

console.log("\n1. Paste Google Slides link");
await page.goto(appUrl, { waitUntil: "networkidle0" });
await page.type("[data-google-slides-url]", shareUrl);
await page.$$eval("button", (buttons) => buttons.find((button) => button.textContent?.trim() === "Import")?.click());

console.log("\n2. Import and parse exported PPTX");
try {
  if (status.configured) {
    await page.waitForSelector("[data-analysis-progress]", { timeout: mobile || constrained ? 240000 : 120000 });
    expect((await page.$$('[data-readiness]')).length === 0, "no local-only result appears before AI settles");
    const cancelled = await page.$$eval("button", (buttons) => {
      const button = buttons.find((candidate) => candidate.textContent?.includes("Cancel analysis"));
      button?.click();
      return !!button;
    });
    expect(cancelled, "combined analysis can be cancelled from processing screen");
  }
  await page.waitForSelector("[data-readiness]", { timeout: mobile || constrained ? 240000 : 120000 });
} catch (error) {
  const state = await page.evaluate(() => ({
    main: document.querySelector("main")?.innerText ?? "",
    status: document.querySelector('[role="status"]')?.textContent ?? "",
    memory: "memory" in performance
      ? {
          used: Math.round(performance.memory.usedJSHeapSize / 1048576),
          total: Math.round(performance.memory.totalJSHeapSize / 1048576),
          limit: Math.round(performance.memory.jsHeapSizeLimit / 1048576),
        }
      : null,
    createImageBitmap: typeof createImageBitmap,
    offscreenCanvas: typeof OffscreenCanvas,
    secure: window.isSecureContext,
  }));
  console.error("  DEBUG", JSON.stringify({ state, consoleErrors, failedRequests }, null, 2));
  await page.screenshot({ path: "scripts/__google-slides-failed.png", fullPage: true });
  await browser.close();
  throw error;
}
await wait(500);
const header = await page.$eval("header", (element) => element.innerText.replace(/\n/g, " "));
expect(/\.pptx\s+·\s+\d+ slides/i.test(header), `deck loaded: ${header}`);

const slideCount = Number(header.match(/·\s+(\d+) slides/i)?.[1] ?? 0);
expect(slideCount > 0, `${slideCount} slides parsed`);

console.log("\n3. Open reconstructed slide view");
await page.$$eval("header button", (buttons) => buttons.find((button) => button.textContent?.trim() === "slides")?.click());
await page.waitForSelector("[data-stage]", { timeout: 30000 });
expect((await page.$$('[data-stage]')).length === 1, "slide preview rendered");
await page.screenshot({ path: "scripts/__google-slides.png" });

expect(consoleErrors.length === 0, `no console errors${consoleErrors.length ? `: ${consoleErrors[0]}` : ""}`);
await browser.close();
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
