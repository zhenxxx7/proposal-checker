export const SEVERITIES = ["error", "warn", "info"] as const;
export const AI_CATEGORIES = [
  "typo",
  "grammar",
  "punctuation",
  "capitalization",
  "consistency",
  "placeholder",
  "image-text",
] as const;

export interface AiFinding {
  slide: number;
  severity: (typeof SEVERITIES)[number];
  category: (typeof AI_CATEGORIES)[number];
  quote: string;
  suggestion: string;
  detail: string;
}

/** Sent as `response_format.json_schema`. Kept flat — free-tier models choke on nesting. */
export const FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          slide: { type: "integer", description: "1-based slide number" },
          severity: { type: "string", enum: [...SEVERITIES] },
          category: { type: "string", enum: [...AI_CATEGORIES] },
          quote: { type: "string", description: "the exact offending text, verbatim" },
          suggestion: { type: "string", description: "the corrected text" },
          detail: { type: "string", description: "one sentence explaining the problem" },
        },
        required: ["slide", "severity", "category", "quote", "suggestion", "detail"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
};

const isSeverity = (v: unknown): v is AiFinding["severity"] =>
  typeof v === "string" && (SEVERITIES as readonly string[]).includes(v);
const isCategory = (v: unknown): v is AiFinding["category"] =>
  typeof v === "string" && (AI_CATEGORIES as readonly string[]).includes(v);

/** Free models drift from the schema. Keep what is usable, drop the rest. */
export function coerceFindings(raw: unknown): AiFinding[] {
  const list = (raw as { findings?: unknown })?.findings;
  if (!Array.isArray(list)) return [];

  const out: AiFinding[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const detail = str(o.detail) || str(o.explanation) || str(o.message);
    if (!detail) continue;
    out.push({
      slide: Number.isFinite(Number(o.slide)) ? Math.max(1, Math.trunc(Number(o.slide))) : 1,
      severity: isSeverity(o.severity) ? o.severity : "warn",
      category: isCategory(o.category) ? o.category : "typo",
      quote: str(o.quote),
      suggestion: str(o.suggestion) || str(o.fix),
      detail,
    });
  }
  return out;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
