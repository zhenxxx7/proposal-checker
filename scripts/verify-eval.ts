/**
 * Pure regression suite for the eval scorers (the future RFT grader terms):
 *   npm run verify:eval
 * No network, no database, no model calls.
 */
import assert from "node:assert/strict";
import {
  composite,
  GRADER_WEIGHTS,
  groundingRate,
  matchFindings,
  scoreCase,
  slideValidity,
  strictValidateFindings,
  summarize,
  type EvalCase,
} from "../lib/ai/evalScorers";
import type { AiFinding } from "../lib/ai/schema";

const finding = (over: Partial<AiFinding>): AiFinding => ({
  slide: 1,
  severity: "error",
  category: "typo",
  quote: "recieve",
  suggestion: "receive",
  detail: "Misspelling of receive.",
  ...over,
});

const CASE: EvalCase = {
  id: "case-1",
  source: "ai-text",
  input: { slides: [{ n: 1, texts: ["We will recieve the assets."] }, { n: 2, texts: ["Clean text"] }] },
  gold: { findings: [finding({})] },
};

// --- strict JSON validation -------------------------------------------------
const strictBody = JSON.stringify({ findings: [finding({})] });
assert.ok(strictValidateFindings(strictBody), "schema-exact raw JSON passes strict validation");
assert.ok(strictValidateFindings('{"findings":[]}'), "an empty findings array is strictly valid");
assert.ok(!strictValidateFindings("```json\n" + strictBody + "\n```"), "fenced output is rejected, never repaired");
assert.ok(!strictValidateFindings('{"findings":[{"slide":1}]}'), "missing fields are rejected");
assert.ok(
  !strictValidateFindings(JSON.stringify({ findings: [{ ...finding({}), extra: true }] })),
  "extra fields are rejected",
);
assert.ok(
  !strictValidateFindings(JSON.stringify({ findings: [finding({ severity: "SEVERE" as never })] })),
  "enum drift is rejected",
);
assert.ok(
  !strictValidateFindings(JSON.stringify({ findings: [finding({})], notes: "hi" })),
  "extra root keys are rejected",
);

// --- grounding + slide validity ----------------------------------------------
assert.equal(groundingRate([finding({})], CASE.input), 1, "verbatim quote grounds");
assert.equal(
  groundingRate([finding({ quote: "We  will   recieve" })], CASE.input),
  1,
  "grounding survives whitespace normalization",
);
assert.equal(
  groundingRate([finding({ quote: "we will recieve" })], CASE.input),
  0,
  "grounding is case-preserving — capitalization findings must match exactly",
);
assert.equal(groundingRate([finding({ quote: "hallucinated" })], CASE.input), 0, "made-up quote does not ground");
assert.equal(groundingRate([finding({ quote: "recieve", slide: 2 })], CASE.input), 0, "wrong slide does not ground");
assert.equal(groundingRate([finding({ quote: "" })], CASE.input), null, "quote-less findings score no grounding");
assert.equal(slideValidity([finding({ slide: 9 })], CASE.input), 0, "invalid slide reference detected");
assert.equal(slideValidity([finding({})], CASE.input), 1, "valid slide reference detected");

// --- matching ----------------------------------------------------------------
const strongMatch = matchFindings([finding({})], CASE.gold.findings);
assert.equal(strongMatch.length, 1);
assert.ok(strongMatch[0].strong, "same slide + same quote is a strong match");
const weakMatch = matchFindings([finding({ quote: "different words" })], CASE.gold.findings);
assert.equal(weakMatch.length, 1);
assert.ok(!weakMatch[0].strong, "same slide + category with a different quote is a weak match");
assert.equal(
  matchFindings([finding({ slide: 2 })], CASE.gold.findings).length,
  0,
  "different slide never matches",
);
assert.equal(
  matchFindings([finding({}), finding({})], CASE.gold.findings).length,
  1,
  "matching is one-to-one — a duplicate prediction finds no second gold",
);

// --- case scoring ------------------------------------------------------------
const perfect = scoreCase(CASE, { rawText: strictBody, findings: [finding({})] });
assert.equal(perfect.jsonValidityStrict, 1);
assert.equal(perfect.f1, 1, "exact prediction scores F1 = 1");
assert.equal(perfect.severityAgreement, 1);
assert.ok(perfect.composite > 0.95, `perfect case scores near 1 (${perfect.composite.toFixed(3)})`);

const empty = scoreCase(CASE, { rawText: '{"findings":[]}', findings: [] });
assert.equal(empty.f1, 0, "missing the gold finding scores F1 = 0");
assert.equal(empty.cleanDeckAccuracy, null, "clean-deck accuracy only applies to gold-empty cases");

const cleanCase: EvalCase = { ...CASE, id: "clean", gold: { findings: [] } };
assert.equal(
  scoreCase(cleanCase, { rawText: '{"findings":[]}', findings: [] }).cleanDeckAccuracy,
  1,
  "empty answer on a clean deck is correct",
);
assert.equal(
  scoreCase(cleanCase, { rawText: strictBody, findings: [finding({})] }).cleanDeckAccuracy,
  0,
  "inventing findings on a clean deck is penalized",
);

// --- false-positive penalty ---------------------------------------------------
const fpCase: EvalCase = { ...CASE, notUsefulKeys: ["key-fp"] };
const keyOf = (f: AiFinding) => (f.quote === "recieve" ? "key-fp" : "other");
const withFp = scoreCase(fpCase, { rawText: strictBody, findings: [finding({})] }, keyOf);
const withoutFp = scoreCase(CASE, { rawText: strictBody, findings: [finding({})] }, () => "other");
assert.equal(withFp.falsePositiveRate, 1, "known false-positive pattern is detected");
assert.ok(
  withFp.composite < withoutFp.composite - GRADER_WEIGHTS.falsePositivePenalty + 0.01,
  "false positives subtract from the composite",
);

// --- composite renormalization + summary --------------------------------------
assert.equal(
  composite({
    id: "x",
    jsonValidityStrict: 1,
    groundingRate: null,
    slideValidity: null,
    precision: null,
    recall: null,
    f1: null,
    cleanDeckAccuracy: 1,
    severityAgreement: null,
    categoryAgreement: null,
    falsePositiveRate: null,
  }),
  1,
  "available terms renormalize to full weight",
);
const summary = summarize([perfect, empty]);
assert.equal(summary.cases, 2);
assert.equal(summary.f1, 0.5, "summary micro-averages per-case metrics");

console.log("PASS eval scorers: strict validation, grounding, matching, penalties, and summaries.");
