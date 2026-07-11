/**
 * Proves a Google share link is downloaded and parsed inside the server route.
 *   npm run verify:server-import -- "path/to/deck.pptx" [app-url]
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import puppeteer from "puppeteer-core";
import { POST } from "../app/api/import-google-slides/route";
import {
  DECK_WIRE_HEADER,
  DECK_WIRE_TYPE,
  deckFromResponse,
  type ImportProgress,
} from "../lib/deckWire";

const CHROME = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find(existsSync);

const fixturePath = process.argv[2];
const appUrl = process.argv[3];
if (!fixturePath) throw new Error('usage: npm run verify:server-import -- "deck.pptx" [app-url]');

const source = readFileSync(resolve(fixturePath));
const sourceBytes = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer;
const calls: { url: string; init?: RequestInit }[] = [];
const originalFetch = globalThis.fetch;

void main();

async function main() {
  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: input instanceof Request ? input.url : String(input), init });
      return new Response(sourceBytes, {
        status: 200,
        headers: {
          "content-disposition": 'attachment; filename="Server import fixture.pptx"',
          "content-length": String(source.byteLength),
          "content-type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        },
      });
    }) as typeof fetch;

    const response = await POST(jsonRequest("https://docs.google.com/presentation/d/ServerImport12345/edit"));
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1, "route must make exactly one upstream download");
    assert.equal(
      calls[0].url,
      "https://docs.google.com/presentation/d/ServerImport12345/export/pptx",
      "server must construct the fixed Google export URL",
    );
    assert.ok(calls[0].init?.signal instanceof AbortSignal, "server download must carry timeout/abort signal");
    assert.equal(response.headers.get("x-download-handler"), "server");
    assert.equal(response.headers.get("x-deck-transfer"), DECK_WIRE_HEADER);
    assert.equal(response.headers.get("content-type"), DECK_WIRE_TYPE);
    assert.equal(response.headers.get("x-accel-buffering"), "no", "stream buffering must be disabled");
    assert.doesNotMatch(
      response.headers.get("content-type") ?? "",
      /officedocument\.presentationml/i,
      "raw PPTX content type must never reach the browser",
    );

    const wireHeaders = Object.fromEntries(response.headers.entries());
    const wireBytes = new Uint8Array(await response.clone().arrayBuffer());
    assert.notDeepEqual([...wireBytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04], "response must not contain raw PPTX");
    assert.ok(wireBytes.byteLength < source.byteLength, "processed browser payload should be smaller than raw PPTX fixture");

    const progress: ImportProgress[] = [];
    const imported = await deckFromResponse(response, (update) => progress.push(update));
    assert.equal(imported.name, "Server import fixture.pptx");
    assert.equal(imported.sourceBytes, source.byteLength);
    assert.ok(imported.deck.slides.length > 0, "server must parse slides before responding");
    assert.ok(imported.deck.blobs.size > 0, "processed preview assets must survive transport");
    assert.ok(imported.assetBytes < source.byteLength, "browser assets should be smaller than raw PPTX fixture");
    assertProgress(progress, source.byteLength, imported.assetBytes);

    const rejected = await POST(jsonRequest("https://example.com/not-a-google-slide.pptx"));
    assert.equal(rejected.status, 400);
    assert.equal(calls.length, 1, "invalid URL must not trigger any upstream fetch");

    if (appUrl) {
      if (!CHROME) throw new Error("Chrome or Edge is required for UI verification.");
      await verifyBrowserImport(appUrl, wireBytes, wireHeaders, imported.deck.slides.length);
    }

    console.log(
      `PASS server import: ${source.byteLength} raw bytes stayed server-side; ` +
        `${wireBytes.byteLength} processed wire bytes, ${imported.deck.slides.length} slides returned.`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function verifyBrowserImport(
  url: string,
  wireBytes: Uint8Array,
  wireHeaders: Record<string, string>,
  slideCount: number,
) {
  const browser = await puppeteer.launch({
    executablePath: CHROME!,
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    const directGoogleRequests: string[] = [];
    const consoleErrors: string[] = [];
    let importRequests = 0;
    page.on("console", (message) => message.type() === "error" && consoleErrors.push(message.text()));
    page.on("pageerror", (error) => consoleErrors.push(String(error)));
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const requestUrl = new URL(request.url());
      if (
        requestUrl.hostname === "docs.google.com" ||
        requestUrl.hostname === "drive.google.com" ||
        requestUrl.hostname.endsWith(".googleusercontent.com")
      ) {
        directGoogleRequests.push(request.url());
      }
      if (requestUrl.pathname === "/api/import-google-slides") {
        importRequests++;
        setTimeout(() => {
          void request.respond({ status: 200, headers: wireHeaders, body: Buffer.from(wireBytes) });
        }, 100);
        return;
      }
      void request.continue();
    });

    await page.goto(url, { waitUntil: "networkidle0" });
    await page.type("[data-google-slides-url]", "https://docs.google.com/presentation/d/ServerImport12345/edit");
    await page.$$eval("button", (buttons) => buttons.find((button) => button.textContent?.trim() === "Import")?.click());
    await page.waitForSelector("[data-processing]", { timeout: 30_000 });
    const importStatus = await page.$eval('[role="status"]', (element) => element.textContent ?? "");
    assert.match(importStatus, /^Downloading Google Slides/i, "UI must identify the download in progress");
    assert.doesNotMatch(importStatus, /Server is/i, "UI must not show the removed 'Server is' wording");
    await page.waitForSelector("[data-readiness]", { timeout: 240_000 });

    const header = await page.$eval("header", (element) => element.innerText);
    assert.match(header, new RegExp(`Server import fixture\\.pptx[\\s\\S]*${slideCount} slides`, "i"));
    assert.equal(importRequests, 1, "browser must call only one same-origin import endpoint");
    assert.deepEqual(directGoogleRequests, [], "browser must never contact Google source hosts");
    assert.deepEqual(consoleErrors, [], "processed import must not produce browser errors");
    console.log("PASS browser import: processed deck rendered without downloading raw Google PPTX.");
  } finally {
    await browser.close();
  }
}

function assertProgress(progress: ImportProgress[], sourceBytes: number, assetBytes: number) {
  const phases = [...new Set(progress.map((update) => update.phase))];
  assert.deepEqual(phases, ["download", "prepare", "transfer"], "wire stream must report each import phase in order");

  const downloads = progress.filter((update) => update.phase === "download");
  assert.equal(downloads[0]?.loaded, 0, "download progress must start at zero");
  assert.equal(downloads[0]?.total, sourceBytes, "download progress must expose the upstream byte total");
  assert.equal(downloads.at(-1)?.loaded, sourceBytes, "download progress must finish at the source byte count");
  assert.equal(downloads.at(-1)?.total, sourceBytes, "completed download must retain its byte total");
  assert.ok(
    downloads.every((update, index) => index === 0 || update.loaded >= downloads[index - 1].loaded),
    "download progress must be monotonic",
  );

  const prepare = progress.find((update) => update.phase === "prepare");
  assert.deepEqual(prepare, { phase: "prepare", loaded: 0, total: null });

  const transfers = progress.filter((update) => update.phase === "transfer");
  assert.equal(transfers[0]?.loaded, 0, "processed transfer progress must start at zero");
  assert.equal(transfers.at(-1)?.loaded, assetBytes, "processed transfer progress must finish at the asset byte count");
  assert.equal(transfers.at(-1)?.total, assetBytes);
}

function jsonRequest(url: string): Request {
  return new Request("http://localhost/api/import-google-slides", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
}
