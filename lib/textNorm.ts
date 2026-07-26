/**
 * Normalise smart quotes, dashes, and whitespace so a verbatim match survives
 * the model retyping “ vs " or collapsing spaces. Case is preserved — a
 * capitalisation finding must still match the exact casing on the slide.
 * Shared by the browser grounding filter and the server-side eval scorers;
 * distinct from `normalizeLearningText` in lib/feedback.ts, which lowercases.
 */
export const normQuote = (s: string) =>
  s
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
