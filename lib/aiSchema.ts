/**
 * JSON Schema handed to Claude via `output_config.format`. Hand-written rather
 * than generated so it stays pinned to what the API accepts: every object needs
 * `required` and `additionalProperties: false`.
 */
export const FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          slide: { type: "integer", description: "1-based slide number" },
          severity: { type: "string", enum: ["error", "warn", "info"] },
          category: {
            type: "string",
            enum: ["typo", "grammar", "punctuation", "capitalization", "consistency", "placeholder", "image-text"],
          },
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

export interface AiFinding {
  slide: number;
  severity: "error" | "warn" | "info";
  category: "typo" | "grammar" | "punctuation" | "capitalization" | "consistency" | "placeholder" | "image-text";
  quote: string;
  suggestion: string;
  detail: string;
}
