/**
 * A deliberately hostile OpenAI-compatible endpoint, for verifying the AI layer
 * without a real key. It:
 *   - rejects `response_format: json_schema` (forces the json_object fallback)
 *   - 429s the first image request (forces the retry path)
 *   - wraps its JSON in ```json fences (forces the fence stripper)
 *   - returns one bogus finding with a wrong severity (forces coerceFindings)
 *
 *   node scripts/mock-ai.mjs [port]
 */
import http from "node:http";

const port = Number(process.argv[2] ?? 11435);
const seen = { text: 0, image: 0, schemaRejected: 0, rateLimited: 0 };

const fence = (obj) => "```json\n" + JSON.stringify(obj, null, 2) + "\n```";
const reply = (res, content) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
};
const fail = (res, code, msg) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: msg } }));
};

http
  .createServer((req, res) => {
    if (!req.url.endsWith("/chat/completions")) return fail(res, 404, "not found");

    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return fail(res, 400, "bad json");
      }

      if (!body.model) return fail(res, 400, "model required");
      const [sys, user] = body.messages ?? [];
      if (sys?.role !== "system" || !sys.content) return fail(res, 400, "system message required");
      if (!Array.isArray(user?.content)) return fail(res, 400, "user content must be parts");

      // 1. Refuse json_schema — most free models do.
      if (body.response_format?.type === "json_schema") {
        seen.schemaRejected++;
        console.log("  ← rejecting response_format=json_schema");
        return fail(res, 400, "Invalid value: 'json_schema'. Unsupported response_format for this model.");
      }

      const image = user.content.find((p) => p.type === "image_url");

      if (image) {
        if (!/^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(image.image_url.url)) {
          return fail(res, 400, "image_url must be a base64 data URL");
        }
        // 2. Rate-limit the first image call.
        if (seen.rateLimited === 0) {
          seen.rateLimited++;
          console.log("  ← 429 on first image (retry path)");
          return fail(res, 429, "rate limit exceeded");
        }
        seen.image++;
        const kb = Math.round((image.image_url.url.length * 0.75) / 1024);
        console.log(`  → image #${seen.image} (${kb}KB, format=${body.response_format?.type ?? "none"})`);

        // Every third image "contains" a typo, so the UI has something to group.
        const findings =
          seen.image % 3 === 0
            ? [
                {
                  slide: 1,
                  severity: "SEVERE", // 3. wrong enum on purpose
                  category: "image-text",
                  quote: "Submitt",
                  suggestion: "Submit",
                  detail: "Primary CTA button reads “Submitt”.",
                },
              ]
            : [];
        return reply(res, fence({ findings }));
      }

      seen.text++;
      const text = user.content.find((p) => p.type === "text")?.text ?? "";
      console.log(`  → text call (${text.length} chars, format=${body.response_format?.type ?? "none"})`);
      return reply(
        res,
        fence({
          findings: [
            {
              slide: 3,
              severity: "error",
              category: "typo",
              quote: "recieve",
              suggestion: "receive",
              detail: "“recieve” is misspelled.",
            },
            { garbage: true }, // 4. junk entry the coercer must drop
          ],
        }),
      );
    });
  })
  .listen(port, () => console.log(`mock AI on http://localhost:${port}/v1  (Ctrl-C to stop)`));

process.on("SIGINT", () => {
  console.log("\n", seen);
  process.exit(0);
});
