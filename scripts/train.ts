/**
 * Managed fine-tuning CLI — no GPU, no self-hosting; jobs run at the provider:
 *   npm run train -- upload --file training-data/sft-train.jsonl
 *   npm run train -- start --method sft|dpo --training-file file-... [--validation-file file-...] [--base <model>] [--suffix slide-anali]
 *   npm run train -- status [--id model-v1-...]
 *   npm run train -- cancel --job ftjob-...
 *   npm run train -- list
 *   npm run train -- promote --id model-v1-... [--force]
 *   npm run train -- rollback --task text
 *
 * Provider-specific calls live behind the TrainingProvider adapter, selected
 * by TRAINING_PROVIDER (default "openai" — currently the only adapter; the
 * choice of provider and billing is the operator's, and nothing here spends
 * money until TRAINING_API_KEY is set and `start` is invoked). Serving stays
 * provider-agnostic: promoted rows carry base_url/model/api_key_env, so any
 * OpenAI-compatible endpoint serves without code changes.
 *
 * NOTE: verify the provider's live fine-tuning API (request shapes, DPO base
 * model eligibility) before the first real run — surfaces shift.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { loadEnvLocal } from "./lib/env.mjs";
import {
  activeModel,
  getModel,
  insertModel,
  listModels,
  promoteModel,
  updateModel,
  type ModelRegistryRow,
} from "../lib/ai/registry";
import type { AiTask } from "../lib/ai/config";
import type { EvalSummary } from "../lib/ai/evalScorers";

loadEnvLocal();

// ---------------------------------------------------------------------------
// Provider adapters
// ---------------------------------------------------------------------------

type TrainingMethod = "sft" | "dpo";

interface JobState {
  jobId: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  servedModelId?: string;
  detail?: string;
}

interface TrainingProvider {
  name: string;
  uploadFile(path: string): Promise<{ fileId: string }>;
  startJob(opts: {
    method: TrainingMethod;
    trainingFileId: string;
    validationFileId?: string;
    baseModel: string;
    suffix?: string;
  }): Promise<{ jobId: string }>;
  getJob(jobId: string): Promise<JobState>;
  cancelJob(jobId: string): Promise<void>;
  /** Where the resulting model is served, for the registry row. */
  servingBaseUrl(): string;
  apiKeyEnv(): string;
}

function openAiProvider(): TrainingProvider {
  const baseUrl = (process.env.TRAINING_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const apiKeyEnv = "TRAINING_API_KEY";
  const key = () => {
    const value = process.env[apiKeyEnv];
    if (!value) throw new Error(`${apiKeyEnv} is not set.`);
    return value;
  };
  const request = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${key()}`, ...(init.headers ?? {}) },
    });
    const body = (await res.json()) as Record<string, unknown> & { error?: { message?: string } };
    if (!res.ok) throw new Error(body.error?.message ?? `${res.status} on ${path}`);
    return body;
  };
  const toState = (job: Record<string, unknown>): JobState => {
    const status = String(job.status ?? "");
    return {
      jobId: String(job.id ?? ""),
      status:
        status === "succeeded"
          ? "succeeded"
          : status === "failed"
            ? "failed"
            : status === "cancelled"
              ? "cancelled"
              : "running",
      servedModelId: typeof job.fine_tuned_model === "string" ? job.fine_tuned_model : undefined,
      detail: status,
    };
  };
  return {
    name: "openai",
    servingBaseUrl: () => baseUrl,
    apiKeyEnv: () => apiKeyEnv,
    async uploadFile(path) {
      const form = new FormData();
      form.set("purpose", "fine-tune");
      form.set("file", new Blob([readFileSync(path)]), basename(path));
      const body = await request("/files", { method: "POST", body: form });
      return { fileId: String(body.id) };
    },
    async startJob({ method, trainingFileId, validationFileId, baseModel, suffix }) {
      // Method schema per OpenAI fine-tuning API; re-verify against live docs
      // before the first real run.
      const body = await request("/fine_tuning/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: baseModel,
          training_file: trainingFileId,
          ...(validationFileId ? { validation_file: validationFileId } : {}),
          ...(suffix ? { suffix } : {}),
          method:
            method === "dpo"
              ? { type: "dpo", dpo: { hyperparameters: { beta: 0.1 } } }
              : { type: "supervised", supervised: { hyperparameters: { n_epochs: "auto" } } },
        }),
      });
      return { jobId: String(body.id) };
    },
    async getJob(jobId) {
      return toState(await request(`/fine_tuning/jobs/${jobId}`));
    },
    async cancelJob(jobId) {
      await request(`/fine_tuning/jobs/${jobId}/cancel`, { method: "POST" });
    },
  };
}

function provider(): TrainingProvider {
  const name = process.env.TRAINING_PROVIDER ?? "openai";
  if (name === "openai") return openAiProvider();
  throw new Error(`Unknown TRAINING_PROVIDER "${name}" — available adapters: openai`);
}

// ---------------------------------------------------------------------------
// Promotion gate
// ---------------------------------------------------------------------------

function summaryOf(row: ModelRegistryRow): EvalSummary | null {
  const results = row.eval_results as { summary?: EvalSummary } | null;
  return results?.summary ?? null;
}

/** A candidate must beat the incumbent on the stored benchmark, not vibes. */
function promotionGate(candidate: ModelRegistryRow, incumbent: ModelRegistryRow | null): string[] {
  const failures: string[] = [];
  const summary = summaryOf(candidate);
  if (!summary) return [`candidate ${candidate.id} has no eval results — run: npm run eval -- --save ${candidate.id}`];
  if (summary.jsonValidityStrict < 0.98) {
    failures.push(`json validity ${summary.jsonValidityStrict.toFixed(3)} < 0.98`);
  }
  const baseline = incumbent ? summaryOf(incumbent) : null;
  if (baseline) {
    if (summary.composite < baseline.composite) {
      failures.push(`composite ${summary.composite.toFixed(3)} < baseline ${baseline.composite.toFixed(3)}`);
    }
    if ((summary.f1 ?? 0) < (baseline.f1 ?? 0) + 0.02) {
      failures.push(`F1 ${(summary.f1 ?? 0).toFixed(3)} is not >= baseline + 0.02 (${((baseline.f1 ?? 0) + 0.02).toFixed(3)})`);
    }
    const within = (a: number | null, b: number | null, label: string) => {
      if (a !== null && b !== null && a < b - 0.01) failures.push(`${label} ${a.toFixed(3)} dropped below baseline ${b.toFixed(3)} - 0.01`);
    };
    within(summary.groundingRate, baseline.groundingRate, "grounding");
    within(summary.cleanDeckAccuracy, baseline.cleanDeckAccuracy, "clean-deck accuracy");
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const command = args[0];
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

async function main() {
  if (!process.env.DATABASE_URL && command !== "upload" && command !== "cancel") {
    console.error("DATABASE_URL is required (model registry).");
    process.exit(1);
  }

  switch (command) {
    case "upload": {
      const file = flag("file");
      if (!file) throw new Error("--file <path.jsonl> is required");
      const { fileId } = await provider().uploadFile(file);
      console.log(`uploaded ${file} -> ${fileId}`);
      break;
    }

    case "start": {
      const method = flag("method") as TrainingMethod | undefined;
      const trainingFileId = flag("training-file");
      if (!method || !["sft", "dpo"].includes(method) || !trainingFileId) {
        throw new Error("--method sft|dpo and --training-file file-... are required");
      }
      const baseModel = flag("base") ?? process.env.TRAINING_MODEL ?? "gpt-4.1-mini-2025-04-14";
      const suffix = flag("suffix") ?? "slide-anali";
      const trainer = provider();
      const { jobId } = await trainer.startJob({
        method,
        trainingFileId,
        validationFileId: flag("validation-file"),
        baseModel,
        suffix,
      });
      const id = `model-v1-${method}-${jobId.replace(/[^a-zA-Z0-9-]/g, "").slice(-12)}`;
      await insertModel({
        id,
        task: "text",
        provider: "custom",
        label: `${trainer.name} ${method}`,
        baseUrl: trainer.servingBaseUrl(),
        baseModel,
        model: baseModel, // replaced by the fine-tuned id on success
        apiKeyEnv: trainer.apiKeyEnv(),
        status: "training",
        jobId,
        method,
      });
      console.log(`started ${method} job ${jobId} on ${baseModel}; registry row ${id}`);
      console.log(`poll with: npm run train -- status --id ${id}`);
      break;
    }

    case "status": {
      const id = flag("id");
      const rows = id ? [await getModel(id)] : await listModels();
      for (const row of rows) {
        if (!row) continue;
        if (row.job_id && (row.status === "training" || row.status === "failed")) {
          try {
            const job = await provider().getJob(row.job_id);
            if (job.status === "succeeded" && job.servedModelId) {
              await updateModel(row.id, { status: "candidate", model: job.servedModelId });
              console.log(`${row.id}: job succeeded -> candidate ${job.servedModelId}`);
              console.log(`evaluate with: npm run eval -- --base-url ${row.base_url} --model ${job.servedModelId} --api-key-env ${row.api_key_env} --save ${row.id}`);
              continue;
            }
            if (job.status === "failed" || job.status === "cancelled") {
              await updateModel(row.id, { status: "failed", notes: job.detail });
              console.log(`${row.id}: job ${job.status}`);
              continue;
            }
            console.log(`${row.id}: job ${row.job_id} still ${job.detail ?? "running"}`);
            continue;
          } catch (error) {
            console.log(`${row.id}: status check failed (${error instanceof Error ? error.message : error})`);
            continue;
          }
        }
        const summary = summaryOf(row);
        console.log(
          `${row.id}: ${row.status} ${row.task}/${row.model}${summary ? ` composite=${summary.composite.toFixed(3)}` : ""}`,
        );
      }
      break;
    }

    case "cancel": {
      const jobId = flag("job");
      if (!jobId) throw new Error("--job ftjob-... is required");
      await provider().cancelJob(jobId);
      console.log(`cancelled ${jobId}`);
      break;
    }

    case "list": {
      for (const row of await listModels()) {
        const summary = summaryOf(row);
        console.log(
          [
            row.id.padEnd(34),
            row.status.padEnd(9),
            row.task.padEnd(5),
            row.model,
            summary ? `composite=${summary.composite.toFixed(3)}` : "no eval",
          ].join("  "),
        );
      }
      break;
    }

    case "promote": {
      const id = flag("id");
      if (!id) throw new Error("--id model-v1-... is required");
      const candidate = await getModel(id);
      if (!candidate) throw new Error(`unknown registry row ${id}`);
      const incumbent = await activeModel(candidate.task);
      const failures = promotionGate(candidate, incumbent);
      if (failures.length && !args.includes("--force")) {
        console.error("promotion gate failed:");
        for (const failure of failures) console.error(`  - ${failure}`);
        console.error("re-run with --force to override.");
        process.exit(1);
      }
      const result = await promoteModel(id);
      if (!result.ok) throw new Error(result.reason);
      console.log(`${id} is now the active ${candidate.task} model${failures.length ? " (gate overridden)" : ""}`);
      break;
    }

    case "rollback": {
      const task = (flag("task") ?? "text") as AiTask;
      const rows = await listModels(task);
      const previous = rows.find((row) => row.status === "retired");
      if (!previous) throw new Error(`no retired ${task} model to roll back to`);
      const result = await promoteModel(previous.id);
      if (!result.ok) throw new Error(result.reason);
      console.log(`rolled ${task} back to ${previous.id} (${previous.model})`);
      break;
    }

    default:
      console.log("commands: upload | start | status | cancel | list | promote | rollback");
      process.exit(command ? 1 : 0);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
