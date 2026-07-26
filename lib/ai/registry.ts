import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { aiConfig, aiConfigFromEnv, type AiConfig, type AiTask, type Provider } from "./config";

/**
 * Model registry: which model serves each task, with dataset stats and eval
 * results per version. Serving resolution order — task env vars (operator
 * kill switch) → active registry row → base env config — and any database
 * error falls back silently, so a bad registry row can never break analysis.
 * Rows store the NAME of the env var holding the API key, never the secret.
 */

const TABLE = "proposal_checker_model_registry";
const CACHE_TTL_MS = 60_000;

export type ModelStatus = "training" | "candidate" | "active" | "retired" | "failed";

export interface ModelRegistryRow {
  id: string;
  task: AiTask;
  provider: string;
  label: string | null;
  base_url: string;
  base_model: string | null;
  model: string;
  api_key_env: string;
  status: ModelStatus;
  job_id: string | null;
  method: string | null;
  dataset_stats: unknown;
  eval_results: unknown;
  notes: string | null;
  created_at: string | Date;
  promoted_at: string | Date | null;
}

let sql: NeonQueryFunction<false, false> | null = null;
let schemaReady: Promise<void> | null = null;

function getSql(): NeonQueryFunction<false, false> {
  if (!process.env.DATABASE_URL) throw new Error("Model registry database is not configured.");
  if (!sql) sql = neon(process.env.DATABASE_URL);
  return sql;
}

async function ensureSchema(): Promise<void> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const db = getSql();
    await db.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id TEXT PRIMARY KEY,
        task TEXT NOT NULL CHECK (task IN ('text', 'image')),
        provider TEXT NOT NULL,
        label TEXT,
        base_url TEXT NOT NULL,
        base_model TEXT,
        model TEXT NOT NULL,
        api_key_env TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('training', 'candidate', 'active', 'retired', 'failed')),
        job_id TEXT,
        method TEXT,
        dataset_stats JSONB,
        eval_results JSONB,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        promoted_at TIMESTAMPTZ
      )
    `);
    // Database invariant: at most one active model per task.
    await db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS pc_model_registry_one_active
      ON ${TABLE} (task) WHERE status = 'active'
    `);
  })().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

export function modelRegistryEnabled(): boolean {
  return Boolean(process.env.DATABASE_URL) && process.env.MODEL_REGISTRY_ENABLED !== "false";
}

function taskEnvOverridden(task: AiTask): boolean {
  const prefix = task === "text" ? "AI_TEXT_" : "AI_IMAGE_";
  return ["PROVIDER", "BASE_URL", "MODEL", "API_KEY"].some((suffix) => process.env[`${prefix}${suffix}`]);
}

export function registryRowToConfig(row: ModelRegistryRow, env: Record<string, string | undefined>): AiConfig {
  const apiKey = env[row.api_key_env] ?? "";
  return {
    provider: row.provider as Provider,
    label: row.label ?? row.provider,
    baseUrl: row.base_url.replace(/\/$/, ""),
    model: row.model,
    apiKey,
    configured: Boolean(row.base_url && row.model && apiKey),
  };
}

export interface ResolvedAiConfig extends AiConfig {
  task: AiTask;
  origin: "env-task" | "registry" | "env";
}

const resolveCache = new Map<AiTask, { at: number; value: ResolvedAiConfig }>();

/** Serving config for a task. Never throws; the env config is the floor. */
export async function resolveAiConfig(task: AiTask): Promise<ResolvedAiConfig> {
  if (taskEnvOverridden(task)) {
    return { ...aiConfigFromEnv(process.env, task), task, origin: "env-task" };
  }
  if (modelRegistryEnabled()) {
    const cached = resolveCache.get(task);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
    try {
      const row = await activeModel(task);
      if (row) {
        const config = registryRowToConfig(row, process.env);
        // A row whose key env var is missing must not silence analysis.
        if (config.configured) {
          const value: ResolvedAiConfig = { ...config, task, origin: "registry" };
          resolveCache.set(task, { at: Date.now(), value });
          return value;
        }
        console.error(`Model registry row ${row.id} needs env var ${row.api_key_env}; falling back to env config.`);
      }
    } catch (error) {
      console.error("Model registry lookup failed; falling back to env config.", error);
    }
  }
  const value: ResolvedAiConfig = { ...aiConfig(task), task, origin: "env" };
  resolveCache.set(task, { at: Date.now(), value });
  return value;
}

export async function activeModel(task: AiTask): Promise<ModelRegistryRow | null> {
  await ensureSchema();
  const rows = (await getSql().query(`SELECT * FROM ${TABLE} WHERE task = $1 AND status = 'active'`, [
    task,
  ])) as ModelRegistryRow[];
  return rows[0] ?? null;
}

export async function getModel(id: string): Promise<ModelRegistryRow | null> {
  await ensureSchema();
  const rows = (await getSql().query(`SELECT * FROM ${TABLE} WHERE id = $1`, [id])) as ModelRegistryRow[];
  return rows[0] ?? null;
}

export async function listModels(task?: AiTask): Promise<ModelRegistryRow[]> {
  await ensureSchema();
  return (await (task
    ? getSql().query(`SELECT * FROM ${TABLE} WHERE task = $1 ORDER BY created_at DESC`, [task])
    : getSql().query(`SELECT * FROM ${TABLE} ORDER BY created_at DESC`))) as ModelRegistryRow[];
}

export async function insertModel(row: {
  id: string;
  task: AiTask;
  provider: string;
  label?: string;
  baseUrl: string;
  baseModel?: string;
  model: string;
  apiKeyEnv: string;
  status: ModelStatus;
  jobId?: string;
  method?: string;
  datasetStats?: unknown;
  notes?: string;
}): Promise<void> {
  await ensureSchema();
  await getSql().query(
    `
      INSERT INTO ${TABLE} (
        id, task, provider, label, base_url, base_model, model, api_key_env,
        status, job_id, method, dataset_stats, notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)
      ON CONFLICT (id) DO NOTHING
    `,
    [
      row.id,
      row.task,
      row.provider,
      row.label ?? null,
      row.baseUrl,
      row.baseModel ?? null,
      row.model,
      row.apiKeyEnv,
      row.status,
      row.jobId ?? null,
      row.method ?? null,
      row.datasetStats ? JSON.stringify(row.datasetStats) : null,
      row.notes ?? null,
    ],
  );
}

export async function updateModel(
  id: string,
  fields: { status?: ModelStatus; model?: string; jobId?: string; evalResults?: unknown; notes?: string },
): Promise<boolean> {
  await ensureSchema();
  const rows = (await getSql().query(
    `
      UPDATE ${TABLE} SET
        status = COALESCE($2, status),
        model = COALESCE($3, model),
        job_id = COALESCE($4, job_id),
        eval_results = COALESCE($5::jsonb, eval_results),
        notes = COALESCE($6, notes)
      WHERE id = $1
      RETURNING id
    `,
    [
      id,
      fields.status ?? null,
      fields.model ?? null,
      fields.jobId ?? null,
      fields.evalResults ? JSON.stringify(fields.evalResults) : null,
      fields.notes ?? null,
    ],
  )) as { id: string }[];
  resolveCache.clear();
  return rows.length > 0;
}

/**
 * Ensures the incumbent env-configured model exists as the active registry
 * row for a task, so even the baseline has a home for eval results. A no-op
 * when any active row already exists. Behavior-neutral: the seeded row
 * resolves to the identical config the env produces.
 */
export async function seedBaseline(task: AiTask): Promise<ModelRegistryRow | null> {
  const current = await activeModel(task);
  if (current) return current;
  const config = aiConfig(task);
  if (!config.baseUrl || !config.model) return null;
  const id = `model-v1-baseline-${task}`;
  await insertModel({
    id,
    task,
    provider: config.provider,
    label: config.label,
    baseUrl: config.baseUrl,
    model: config.model,
    apiKeyEnv: taskEnvOverridden(task) ? `AI_${task.toUpperCase()}_API_KEY` : "AI_API_KEY",
    status: "active",
    notes: "Seeded baseline: the env-configured incumbent model.",
  });
  return getModel(id);
}

/** Two-statement promotion; rollback is the inverse via the same function. */
export async function promoteModel(id: string): Promise<{ ok: boolean; reason?: string }> {
  await ensureSchema();
  const candidate = await getModel(id);
  if (!candidate) return { ok: false, reason: "unknown model id" };
  if (candidate.status === "active") return { ok: true };
  const db = getSql();
  await db.query(`UPDATE ${TABLE} SET status = 'retired' WHERE task = $1 AND status = 'active'`, [candidate.task]);
  await db.query(`UPDATE ${TABLE} SET status = 'active', promoted_at = NOW() WHERE id = $1`, [id]);
  resolveCache.clear();
  return { ok: true };
}
