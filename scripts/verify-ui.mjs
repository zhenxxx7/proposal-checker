/**
 * Drives the real UI in a real browser against a real .pptx.
 *   node scripts/verify-ui.mjs <deck.pptx> [url]
 * Requires the dev server to be running.
 */
import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";

const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find(existsSync);

const deck = process.argv[2];
const url = process.argv[3] ?? "http://localhost:3000/";
if (!deck || !CHROME) throw new Error("usage: node scripts/verify-ui.mjs <deck.pptx> [url]  (no browser found)");

const ok = (cond, msg) => console.log(`${cond ? "  PASS" : "  FAIL"}  ${msg}`) || cond;
let failures = 0;
const expect = (cond, msg) => {
  if (!ok(cond, msg)) failures++;
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--window-size=1600,1000"],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();

const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));

console.log("\n1. Load the app");
await page.goto(url, { waitUntil: "networkidle0" });
expect(await page.$eval("h1", (e) => e.textContent) === "Proposal Checker", "header renders");
expect((await page.$$("input[type=file]")).length === 1, "dropzone present");
expect((await page.title()) === "Proposal Checker", `document title: "${await page.title()}"`);

const layout = await page.evaluate(() => {
  const m = document.querySelector("main");
  return { main: Math.round(m.getBoundingClientRect().width), vw: innerWidth, font: getComputedStyle(document.body).fontFamily };
});
expect(layout.main >= layout.vw - 60, `main fills the viewport (${layout.main}px of ${layout.vw}px)`);
expect(/Geist/i.test(layout.font), `Geist font applied: ${layout.font.slice(0, 40)}`);
const aiLabel = await page.$$eval("header *", (els) =>
  els.map((e) => e.textContent).find((t) => t?.includes("API key") || t?.includes("Deep check")) ?? "",
);
console.log(`  info  AI control before upload: ${JSON.stringify(aiLabel)}`);

console.log("\n2. Upload the deck");
const input = await page.$("input[type=file]");
await input.uploadFile(deck);
await page.waitForSelector("section", { timeout: 60000 });
await new Promise((r) => setTimeout(r, 1200));

console.log("\n3. Summary view");
const banner = await page.$eval("h2", (e) => e.textContent);
expect(/Not ready to send|Almost ready|Ready to send/.test(banner), `readiness banner: "${banner}"`);

const stats = await page.$$eval("main p.tabular-nums", (els) => els.map((e) => e.textContent));
expect(stats.length === 3, `three stat tiles: ${stats.join(" / ")}`);

const cards = await page.$$eval("section[class*=border-l-]", (els) =>
  els.map((e) => e.querySelector("span.block.text-sm")?.textContent).filter(Boolean),
);
expect(cards.length >= 5 && cards.length <= 14, `${cards.length} group cards (not a wall of rows)`);
cards.forEach((c) => console.log(`        · ${c}`));

const aiBtn = await page.$$eval("header *", (els) =>
  els.map((e) => e.textContent).find((t) => t?.includes("API key") || t?.includes("Deep check")) ?? "",
);
expect(aiBtn.includes("API key"), `AI button disabled with reason: "${aiBtn}"`);

await page.screenshot({ path: "scripts/__summary.png" });

console.log("\n4. Expand a group, click a finding -> jumps to slide view");
const firstFinding = await page.$('div[role="button"]');
expect(!!firstFinding, "first group auto-expanded (blocking issues visible)");
await firstFinding.click();
await new Promise((r) => setTimeout(r, 800));

const inSlides = await page.$$eval("header button", (els) =>
  els.some((e) => e.textContent === "slides" && e.className.includes("bg-neutral-900")),
);
expect(inSlides, "switched to slides view");

const highlighted = (await page.$$("section [class*=outline-rose-500]")).length;
expect(highlighted >= 1, `offending shape highlighted (${highlighted})`);
await page.screenshot({ path: "scripts/__slides.png" });

console.log("\n5. Slide rail thumbnails render lazily");
const thumbs = await page.$$("nav button");
const mounted = await page.$$eval("nav button", (els) =>
  els.filter((e) => e.querySelector("img") || e.querySelector("p")).length,
);
expect(thumbs.length > 0, `${thumbs.length} slide thumbs`);
expect(mounted < thumbs.length || thumbs.length < 12, `only ${mounted}/${thumbs.length} mounted (lazy)`);

console.log("\n6. Keyboard navigation");
const before = await page.$eval("section + section p, section p.text-xs", (e) => e.textContent).catch(() => "");
await page.keyboard.press("ArrowRight");
await new Promise((r) => setTimeout(r, 400));
const after = await page.$eval("section + section p, section p.text-xs", (e) => e.textContent).catch(() => "");
expect(before !== after, `ArrowRight advances slide (${(before || "").slice(0, 18)} -> ${(after || "").slice(0, 18)})`);

console.log("\n7. Search filters the list but never the verdict");
await page.$$eval("header button", (els) => els.find((e) => e.textContent === "summary")?.click());
await new Promise((r) => setTimeout(r, 400));
await page.type('input[placeholder="Search findings…"]', "blurry");
await new Promise((r) => setTimeout(r, 600));

const filtered = await page.$$eval("section[class*=border-l-]", (els) => els.length);
expect(filtered >= 1 && filtered <= 3, `search "blurry" narrows to ${filtered} group(s)`);

const banner2 = await page.$eval("h2", (e) => e.textContent);
const stats2 = await page.$$eval("main p.tabular-nums", (els) => els.map((e) => e.textContent));
expect(banner2 === banner, `verdict unchanged while searching: "${banner2}"`);
expect(stats2.join("/") === stats.join("/"), `stat tiles unchanged: ${stats2.join(" / ")} (was ${stats.join(" / ")})`);

const note = await page.$$eval("main p", (els) =>
  els.map((e) => e.textContent).find((t) => t?.includes("showing")) ?? "",
);
expect(note.includes("showing"), `search count shown separately: "${note}"`);

await page.screenshot({ path: "scripts/__search.png" });
console.log("\n  screenshots -> scripts/__summary.png __slides.png __search.png");

console.log(`\n  console errors: ${consoleErrors.length}`);
consoleErrors.slice(0, 6).forEach((e) => console.log(`    ! ${e.slice(0, 160)}`));
expect(consoleErrors.length === 0, "no console errors");

await browser.close();
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
