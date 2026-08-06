export const SEVERITIES = ["error", "warn", "info"] as const;
export const AI_CATEGORIES = [
  "typo",
  "grammar",
  "spacing",
  "punctuation",
  "capitalization",
  "consistency",
  "placeholder",
  "resolution",
  "aspect",
  "alignment",
  "geometry",
  "image-text",
] as const;

export interface AiFinding {
  slide: number;
  severity: (typeof SEVERITIES)[number];
  category: (typeof AI_CATEGORIES)[number];
  /** Verbatim slide or image text; blank for a layout-only finding. */
  quote: string;
  suggestion: string;
  detail: string;
  /** Exact slide shape IDs used to ground layout/image-quality findings. */
  shapeIds?: string[];
  /** Other slides involved in a cross-slide consistency finding. */
  relatedSlides?: number[];
}

/** Sent as response_format.json_schema. Keep it flat for provider compatibility. */
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
          quote: { type: "string", description: "verbatim offending text, or empty for layout-only" },
          suggestion: { type: "string", description: "the concrete corrected text or action" },
          detail: { type: "string", description: "one sentence explaining the client-visible problem" },
          shapeIds: { type: "array", items: { type: "string" } },
          relatedSlides: { type: "array", items: { type: "integer" } },
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

/** Free models drift from schema. Keep only bounded, usable fields. */
export function coerceFindings(raw: unknown): AiFinding[] {
  const list = (raw as { findings?: unknown })?.findings;
  if (!Array.isArray(list)) return [];

  const out: AiFinding[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const detail = str(o.detail) || str(o.explanation) || str(o.message);
    if (!detail) continue;
    const shapeIds = strings(o.shapeIds, 100, 256);
    const relatedSlides = integers(o.relatedSlides, 1000);
    out.push({
      slide: Number.isFinite(Number(o.slide)) ? Math.max(1, Math.trunc(Number(o.slide))) : 1,
      severity: isSeverity(o.severity) ? o.severity : "warn",
      category: isCategory(o.category) ? o.category : "typo",
      quote: str(o.quote),
      suggestion: str(o.suggestion) || str(o.fix),
      detail: detail.slice(0, 8_000),
      ...(shapeIds?.length ? { shapeIds } : {}),
      ...(relatedSlides?.length ? { relatedSlides } : {}),
    });
  }
  return out;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function strings(value: unknown, maxItems: number, maxLength: number): string[] | undefined {
  if (!Array.isArray(value) || value.length > maxItems) return undefined;
  const result = value.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= maxLength);
  return result.length === value.length ? [...new Set(result)] : undefined;
}

function integers(value: unknown, maxItems: number): number[] | undefined {
  if (!Array.isArray(value) || value.length > maxItems) return undefined;
  const result = value.filter((item): item is number => Number.isInteger(item) && item > 0);
  return result.length === value.length ? [...new Set(result)] : undefined;
}
