import { aiConfig } from "./config";
import { coerceFindings, FINDINGS_SCHEMA, type AiFinding } from "./schema";

export type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

const TIMEOUT_MS = 120_000;

export class AiError extends Error {}

type Mode = "json_schema" | "json_object" | "none";
const MODES: Mode[] = ["json_schema", "json_object", "none"];

/**
 * Which response_format this endpoint actually accepted. Discovered once, then
 * reused: a deck sends ~30 image requests, and re-probing json_schema on each
 * one would burn 30 rejections against a rate-limited free tier.
 */
let negotiated: Mode | null = null;

/**
 * One structured-output call against any OpenAI-compatible endpoint.
 * Gemini, OpenRouter, and any remote OpenAI-compatible endpoint accept this body.
 */
export async function askForFindings(system: string, parts: Part[]): Promise<AiFinding[]> {
  const cfg = aiConfig();
  if (!cfg.configured) throw new AiError("AI provider is not configured.");

  // Not every free model implements json_schema; json_object is the fallback,
  // and a few implement neither, in which case the prompt alone has to carry it.
  // Start from the known-good mode, but keep the rest as fallbacks.
  const ladder = negotiated ? [negotiated, ...MODES.filter((m) => m !== negotiated)] : MODES;

  let lastError = "";
  for (const mode of ladder) {
    try {
      const text = await complete(cfg.baseUrl, cfg.apiKey, cfg.model, system, parts, mode);
      negotiated = mode;
      return coerceFindings(parseJson(text));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastError = msg;
      // Only step down the ladder when the endpoint rejected the response format.
      if (!/response_format|json_schema|Unsupported|Invalid|400/i.test(msg)) throw new AiError(msg);
    }
  }
  negotiated = null;
  throw new AiError(lastError || "AI request failed.");
}

async function complete(
  baseUrl: string,
  apiKey: string,
  model: string,
  system: string,
  parts: Part[],
  mode: "json_schema" | "json_object" | "none",
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    temperature: 0.1,
    max_tokens: 8192,
    messages: [
      { role: "system", content: system },
      { role: "user", content: parts },
    ],
  };
  if (mode === "json_schema") {
    body.response_format = { type: "json_schema", json_schema: { name: "findings", schema: FINDINGS_SCHEMA } };
  } else if (mode === "json_object") {
    body.response_format = { type: "json_object" };
  }

  const res = await fetchRetry(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);

  const json = (await res.json()) as {
    choices?: { message?: { content?: string | Part[] } }[];
    error?: { message?: string };
  };
  if (json.error?.message) throw new Error(json.error.message);

  const content = json.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  // Some gateways return content as an array of parts.
  if (Array.isArray(content)) return content.map((p) => (p.type === "text" ? p.text : "")).join("");
  throw new Error("Empty response from model.");
}

/** Free tiers rate-limit aggressively; back off, and obey Retry-After when given. */
async function fetchRetry(url: string, init: RequestInit, attempts = 4): Promise<Response> {
  let last: Response | undefined;
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(url, init);
    if (res.ok || (res.status !== 429 && res.status < 500)) return res;
    last = res;
    if (i === attempts - 1) break;

    const retryAfter = Number(res.headers.get("retry-after"));
    const backoff = 800 * 2 ** i;
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 60_000) : backoff);
  }
  return last!;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Models wrap JSON in ```json fences, or prepend prose. Dig it out. */
function parseJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    // fall through
  }
  const start = cleaned.indexOf("{");
  if (start === -1) return {};
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (esc) esc = false;
    else if (c === "\\") esc = true;
    else if (c === '"') inStr = !inStr;
    else if (!inStr && c === "{") depth++;
    else if (!inStr && c === "}" && --depth === 0) {
      try {
        return JSON.parse(cleaned.slice(start, i + 1));
      } catch {
        return {};
      }
    }
  }
  return {};
}
