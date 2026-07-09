/**
 * Exercises the AI routes end-to-end against whatever provider is configured.
 * Point AI_BASE_URL at scripts/mock-ai.mjs (with a throwaway AI_API_KEY).
 *
 *   node scripts/verify-ai.mjs [baseUrl]
 */
const base = process.argv[2] ?? "http://localhost:3000";

let failures = 0;
const expect = (cond, msg) => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures++;
};

const post = async (path, body) => {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
};

// A 1x1 white JPEG.
const JPEG_1PX =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

console.log("\n1. /api/status");
const status = await (await fetch(`${base}/api/status`)).json();
console.log(`  info  provider=${status.label} model=${status.model} configured=${status.configured}`);
expect(status.configured === true, "provider is configured");

console.log("\n2. /api/analyze-text");
const text = await post("/api/analyze-text", {
  slides: [
    { n: 1, texts: ["Welcome to the deck"] },
    { n: 3, texts: ["We will recieve the files next week."] },
  ],
});
expect(text.status === 200, `HTTP ${text.status}${text.json.error ? ` — ${text.json.error}` : ""}`);
expect(Array.isArray(text.json.findings), "returns a findings array");
expect(text.json.findings.length === 1, `junk entry dropped by coercer (${text.json.findings.length} kept)`);
const t = text.json.findings[0];
expect(
  t?.quote === "recieve" && t?.suggestion === "receive",
  `parsed through markdown code fences: ${JSON.stringify(t?.quote)} -> ${JSON.stringify(t?.suggestion)}`,
);
expect(t?.slide === 3, `slide number preserved (${t?.slide})`);

console.log("\n3. /api/analyze-image  (first call is rate-limited by the mock)");
let img;
for (let i = 1; i <= 3; i++) {
  img = await post("/api/analyze-image", {
    slide: 7,
    image: JPEG_1PX,
    mediaType: "image/jpeg",
    slideText: "Submit your entry",
    displayPx: { w: 640, h: 360 },
  });
  expect(img.status === 200, `call ${i}: HTTP ${img.status}${img.json.error ? ` — ${img.json.error}` : ""}`);
  if (img.json.findings?.length) break;
}
expect(img.json.findings.length === 1, `found the in-image typo (${img.json.findings.length})`);
const f = img.json.findings[0];
expect(f?.quote === "Submitt" && f?.suggestion === "Submit", `in-image quote/fix: ${JSON.stringify(f?.quote)} → ${JSON.stringify(f?.suggestion)}`);
expect(f?.severity === "warn", `bogus severity "SEVERE" coerced to "${f?.severity}"`);
expect(f?.slide === 7, `slide forced to the caller's value (${f?.slide})`);
expect(f?.category === "image-text", `category forced to image-text`);

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
