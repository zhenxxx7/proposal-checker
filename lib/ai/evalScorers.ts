import { normQuote } from "../textNorm";
import { AI_CATEGORIES, SEVERITIES, type AiFinding } from "./schema";

/**
 * Pure scoring for the evaluation benchmark. This module doubles as the
 * specification of the future RFT grader: every term here ports 1:1 to a
 * provider-side grader, with GRADER_WEIGHTS as the single place to tune the
 * reward mix. No I/O, no model calls — testable with fixtures.
 */

export interface EvalCase {
  id: string;
  source: "ai-text" | "ai-image";
  input: { slides: { n: number; texts: string[] }[] };
  gold: { findings: AiFinding[] };
  /** Learning keys of known false-positive patterns for this deck. */
  notUsefulKeys?: string[];
}

export interface ModelAnswer {
  /** Raw model text before any tolerant parsing. */
  rawText: string;
  /** Findings after the production parse/coerce pipeline. */
  findings: AiFinding[];
}

export interface CaseScore {
  id: string;
  /** Raw response is already strict, schema-exact JSON — reject, not repair. */
  jsonValidityStrict: 0 | 1;
  groundingRate: number | null;
  slideValidity: number | null;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  /** Only for gold-empty cases: did the model return no findings? */
  cleanDeckAccuracy: 0 | 1 | null;
  severityAgreement: number | null;
  categoryAgreement: number | null;
  falsePositiveRate: number | null;
  composite: number;
}

/** The reward mix — shared verbatim by the future RFT grader. */
export const GRADER_WEIGHTS = {
  jsonValidity: 0.2,
  grounding: 0.2,
  slideValidity: 0.05,
  f1: 0.25,
  severityAgreement: 0.1,
  categoryAgreement: 0.05,
  cleanDeckAccuracy: 0.15,
  falsePositivePenalty: 0.25,
} as const;

const SEVERITY_SET = new Set<string>(SEVERITIES);
const CATEGORY_SET = new Set<string>(AI_CATEGORIES);

/**
 * Strict schema validation of the RAW model text: exact root shape, exactly
 * the six fields, enum membership, integer slide >= 1, non-empty detail.
 * The production path repairs; the eval (and grader) must reject instead.
 */
export function strictValidateFindings(rawText: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText.trim());
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const keys = Object.keys(parsed as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "findings") return false;
  const findings = (parsed as { findings: unknown }).findings;
  if (!Array.isArray(findings)) return false;
  return findings.every((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
    const o = item as Record<string, unknown>;
    const fields = Object.keys(o).sort();
    if (fields.join(",") !== "category,detail,quote,severity,slide,suggestion") return false;
    return (
      Number.isInteger(o.slide) &&
      (o.slide as number) >= 1 &&
      typeof o.severity === "string" &&
      SEVERITY_SET.has(o.severity) &&
      typeof o.category === "string" &&
      CATEGORY_SET.has(o.category) &&
      typeof o.quote === "string" &&
      typeof o.suggestion === "string" &&
      typeof o.detail === "string" &&
      o.detail.trim().length > 0
    );
  });
}

/** Fraction of quoted findings whose quote really appears on their slide. */
export function groundingRate(findings: readonly AiFinding[], input: EvalCase["input"]): number | null {
  const textByN = new Map(input.slides.map((s) => [s.n, normQuote(s.texts.join("\n"))]));
  const quoted = findings.filter((f) => f.quote.trim().length > 0);
  if (!quoted.length) return null;
  const grounded = quoted.filter((f) => (textByN.get(f.slide) ?? "").includes(normQuote(f.quote)));
  return grounded.length / quoted.length;
}

export function slideValidity(findings: readonly AiFinding[], input: EvalCase["input"]): number | null {
  if (!findings.length) return null;
  const slides = new Set(input.slides.map((s) => s.n));
  return findings.filter((f) => slides.has(f.slide)).length / findings.length;
}

interface Match {
  predicted: AiFinding;
  gold: AiFinding;
  strong: boolean;
}

/** Greedy 1:1 matching: strong = same slide + quotes agree; weak = same slide + category. */
export function matchFindings(predicted: readonly AiFinding[], gold: readonly AiFinding[]): Match[] {
  const remaining = [...gold];
  const matches: Match[] = [];
  const take = (predictedFinding: AiFinding, strong: boolean, index: number) => {
    matches.push({ predicted: predictedFinding, gold: remaining[index], strong });
    remaining.splice(index, 1);
  };
  for (const p of predicted) {
    const strongIndex = remaining.findIndex((g) => {
      if (g.slide !== p.slide) return false;
      const a = normQuote(p.quote);
      const b = normQuote(g.quote);
      return a.length > 0 && b.length > 0 && (a === b || a.includes(b) || b.includes(a));
    });
    if (strongIndex >= 0) {
      take(p, true, strongIndex);
      continue;
    }
    const weakIndex = remaining.findIndex((g) => g.slide === p.slide && g.category === p.category);
    if (weakIndex >= 0) take(p, false, weakIndex);
  }
  return matches;
}

function matchCredit(matches: readonly Match[]): number {
  return matches.reduce((total, match) => total + (match.strong ? 1 : 0.5), 0);
}

export function scoreCase(
  evalCase: EvalCase,
  answer: ModelAnswer,
  learningKeyOf?: (finding: AiFinding) => string,
): CaseScore {
  const { findings } = answer;
  const goldFindings = evalCase.gold.findings;
  const matches = matchFindings(findings, goldFindings);
  const credit = matchCredit(matches);
  const strong = matches.filter((m) => m.strong);

  const precision = findings.length ? credit / findings.length : null;
  const recall = goldFindings.length ? credit / goldFindings.length : null;
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : goldFindings.length
        ? 0
        : null;

  const notUseful = new Set(evalCase.notUsefulKeys ?? []);
  const falsePositiveRate =
    findings.length && notUseful.size && learningKeyOf
      ? findings.filter((f) => notUseful.has(learningKeyOf(f))).length / findings.length
      : findings.length && notUseful.size
        ? null
        : findings.length
          ? 0
          : null;

  const score: Omit<CaseScore, "composite"> = {
    id: evalCase.id,
    jsonValidityStrict: strictValidateFindings(answer.rawText) ? 1 : 0,
    groundingRate: groundingRate(findings, evalCase.input),
    slideValidity: slideValidity(findings, evalCase.input),
    precision,
    recall,
    f1,
    cleanDeckAccuracy: goldFindings.length === 0 ? (findings.length === 0 ? 1 : 0) : null,
    severityAgreement: strong.length
      ? strong.filter((m) => m.predicted.severity === m.gold.severity).length / strong.length
      : null,
    categoryAgreement: strong.length
      ? strong.filter((m) => m.predicted.category === m.gold.category).length / strong.length
      : null,
    falsePositiveRate,
  };
  return { ...score, composite: composite(score) };
}

/**
 * Weighted mix over the metrics a case actually produced (weights renormalize
 * across available terms), minus the false-positive penalty, floored at 0.
 */
export function composite(score: Omit<CaseScore, "composite">): number {
  const terms: [number | null, number][] = [
    [score.jsonValidityStrict, GRADER_WEIGHTS.jsonValidity],
    [score.groundingRate, GRADER_WEIGHTS.grounding],
    [score.slideValidity, GRADER_WEIGHTS.slideValidity],
    [score.f1, GRADER_WEIGHTS.f1],
    [score.severityAgreement, GRADER_WEIGHTS.severityAgreement],
    [score.categoryAgreement, GRADER_WEIGHTS.categoryAgreement],
    [score.cleanDeckAccuracy, GRADER_WEIGHTS.cleanDeckAccuracy],
  ];
  let weighted = 0;
  let totalWeight = 0;
  for (const [value, weight] of terms) {
    if (value === null) continue;
    weighted += value * weight;
    totalWeight += weight;
  }
  const base = totalWeight > 0 ? weighted / totalWeight : 0;
  const penalty = (score.falsePositiveRate ?? 0) * GRADER_WEIGHTS.falsePositivePenalty;
  return Math.max(0, base - penalty);
}

export interface EvalSummary {
  cases: number;
  jsonValidityStrict: number;
  groundingRate: number | null;
  slideValidity: number | null;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  cleanDeckAccuracy: number | null;
  severityAgreement: number | null;
  categoryAgreement: number | null;
  falsePositiveRate: number | null;
  composite: number;
}

function mean(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length ? present.reduce((a, b) => a + b, 0) / present.length : null;
}

export function summarize(scores: readonly CaseScore[]): EvalSummary {
  return {
    cases: scores.length,
    jsonValidityStrict: mean(scores.map((s) => s.jsonValidityStrict)) ?? 0,
    groundingRate: mean(scores.map((s) => s.groundingRate)),
    slideValidity: mean(scores.map((s) => s.slideValidity)),
    precision: mean(scores.map((s) => s.precision)),
    recall: mean(scores.map((s) => s.recall)),
    f1: mean(scores.map((s) => s.f1)),
    cleanDeckAccuracy: mean(scores.map((s) => s.cleanDeckAccuracy)),
    severityAgreement: mean(scores.map((s) => s.severityAgreement)),
    categoryAgreement: mean(scores.map((s) => s.categoryAgreement)),
    falsePositiveRate: mean(scores.map((s) => s.falsePositiveRate)),
    composite: mean(scores.map((s) => s.composite)) ?? 0,
  };
}
