/**
 * Runs the benchmark against a model and reports scorecard metrics:
 *   npm run eval -- --cases scripts/fixtures/eval-cases.jsonl
 *     [--provider gemini|openrouter|custom --base-url <url> --model <id> --api-key-env <ENV_NAME>]
 *     [--task text] [--save baseline|<registry-id>] [--json]
 *
 * Without model flags it evaluates the env-configured model for the task —
 * run this against real Gemini FIRST so the incumbent has stored results
 * before any fine-tuned candidate is compared. Uses the production prompt
 * WITHOUT feedback memory: training and eval must measure the model, not the
 * runtime retrieval layer.
 */
import { readFileSync } from "node:fs";
import { loadEnvLocal } from "./lib/env.mjs";
import { askForFindings } from "../lib/ai/client";
import { aiConfig, type AiConfig, type AiTask, type Provider } from "../lib/ai/config";
import { promptVersionFor, TEXT_SYSTEM_PROMPT } from "../lib/ai/prompts";
import { scoreCase, summarize, type CaseScore, type EvalCase } from "../lib/ai/evalScorers";
import { feedbackLearningKey } from "../lib/feedback";
import type { AiFinding } from "../lib/ai/schema";

loadEnvLocal();

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const caseFiles = args
  .flatMap((value, index) => (args[index - 1] === "--cases" || value.endsWith(".jsonl") ? [value] : []))
  .filter((value, index, all) => value.endsWith(".jsonl") && all.indexOf(value) === index);
if (!caseFiles.length) caseFiles.push("scripts/fixtures/eval-cases.jsonl");

const task = (flag("task") ?? "text") as AiTask;
const asJson = args.includes("--json");
const save = flag("save");

const overrides = {
  provider: flag("provider") as Provider | undefined,
  baseUrl: flag("base-url"),
  model: flag("model"),
  apiKeyEnv: flag("api-key-env"),
};
const base = aiConfig(task);
const cfg: AiConfig = {
  provider: overrides.provider ?? base.provider,
  label: overrides.provider ?? base.label,
  baseUrl: (overrides.baseUrl ?? base.baseUrl).replace(/\/$/, ""),
  model: overrides.model ?? base.model,
  apiKey: overrides.apiKeyEnv ? process.env[overrides.apiKeyEnv] ?? "" : base.apiKey,
  configured: true,
};
cfg.configured = Boolean(cfg.baseUrl && cfg.model && cfg.apiKey);
if (!cfg.configured) {
  console.error("No configured model: set AI_* env vars or pass --base-url/--model/--api-key-env.");
  process.exit(1);
}

const cases: EvalCase[] = caseFiles.flatMap((file) =>
  readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EvalCase),
);
console.log(`evaluating ${cfg.model} on ${cases.length} case(s) from ${caseFiles.join(", ")}`);

const learningKeyOf = (source: EvalCase["source"]) => (finding: AiFinding) =>
  feedbackLearningKey({
    source,
    code: source === "ai-image" ? "ai.image" : "ai.text",
    category: finding.category,
    title: finding.quote || finding.detail,
    detail: finding.detail,
    quote: finding.quote,
    suggestion: finding.suggestion,
  });

async function main() {
const scores: CaseScore[] = [];
let cursor = 0;
const worker = async () => {
  while (cursor < cases.length) {
    const evalCase = cases[cursor++];
    const framed = evalCase.input.slides.map((s) => `--- SLIDE ${s.n} ---\n${s.texts.join("\n")}`).join("\n\n");
    try {
      const result = await askForFindings(
        TEXT_SYSTEM_PROMPT,
        [{ type: "text", text: `Proofread this deck. ${evalCase.input.slides.length} slides.\n\n${framed}` }],
        cfg,
      );
      const score = scoreCase(evalCase, { rawText: result.rawText, findings: result.findings }, learningKeyOf(evalCase.source));
      scores.push(score);
      console.log(`  ${score.composite.toFixed(3)}  ${evalCase.id}`);
    } catch (error) {
      scores.push(
        scoreCase(evalCase, { rawText: "", findings: [] }, learningKeyOf(evalCase.source)),
      );
      console.log(`  0.000  ${evalCase.id} (request failed: ${error instanceof Error ? error.message : error})`);
    }
  }
};
await Promise.all([worker(), worker()]);

const summary = summarize(scores);
const results = {
  model: cfg.model,
  provider: cfg.provider,
  promptVersion: promptVersionFor(task === "image" ? "ai-image" : "ai-text"),
  caseFiles,
  evaluatedAt: new Date().toISOString(),
  summary,
};

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const pct = (value: number | null) => (value === null ? "  n/a" : (value * 100).toFixed(1).padStart(5));
  console.log(`
  cases                 ${summary.cases}
  json validity (strict) ${pct(summary.jsonValidityStrict)}%
  grounding rate         ${pct(summary.groundingRate)}%
  slide validity         ${pct(summary.slideValidity)}%
  precision / recall     ${pct(summary.precision)}% / ${pct(summary.recall)}%
  F1                     ${pct(summary.f1)}%
  clean-deck accuracy    ${pct(summary.cleanDeckAccuracy)}%
  severity agreement     ${pct(summary.severityAgreement)}%
  category agreement     ${pct(summary.categoryAgreement)}%
  false-positive rate    ${pct(summary.falsePositiveRate)}%
  composite              ${summary.composite.toFixed(3)}
`);
}

if (save) {
  const { seedBaseline, updateModel, getModel } = await import("../lib/ai/registry");
  if (!process.env.DATABASE_URL) {
    console.error("--save needs DATABASE_URL for the model registry.");
    process.exit(1);
  }
  const id = save === "baseline" ? (await seedBaseline(task))?.id : save;
  if (!id || !(await getModel(id))) {
    console.error(`--save: registry row not found (${save}).`);
    process.exit(1);
  }
  await updateModel(id, { evalResults: results });
  console.log(`saved eval results to registry row ${id}`);
}
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
