/**
 * Every supported provider speaks the OpenAI chat-completions shape, so the
 * whole AI layer is one fetch and a base URL. Switching provider is one env var.
 *
 * Only hosted, non-local providers are supported — the app is built to deploy
 * on Vercel serverless, where a localhost endpoint (Ollama, LM Studio) is
 * unreachable. `custom` is an escape hatch for any *remote* OpenAI-compatible
 * endpoint you point AI_BASE_URL at.
 */
export type Provider = "gemini" | "openrouter" | "custom";

interface Preset {
  baseUrl: string;
  model: string;
  label: string;
}

const PRESETS: Record<Exclude<Provider, "custom">, Preset> = {
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    // Paid tier default: the stronger vision model. Free tier still works but
    // Pro caps requests-per-minute lower than flash — override AI_MODEL to
    // gemini-2.5-flash if throughput matters more than reasoning quality.
    model: "gemini-2.5-pro",
    label: "Gemini",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    model: "qwen/qwen2.5-vl-72b-instruct:free",
    label: "OpenRouter",
  },
};

export interface AiConfig {
  provider: Provider;
  label: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  configured: boolean;
}

/**
 * The two AI passes can serve from different models — e.g. Gemini keeps the
 * vision pass while a fine-tuned model takes text findings. Task-scoped env
 * vars (AI_TEXT_*, AI_IMAGE_*) override the plain AI_* set per task.
 */
export type AiTask = "text" | "image";

/** Pure function of an env record, so tests never have to mutate process.env. */
export function aiConfigFromEnv(env: Record<string, string | undefined>, task?: AiTask): AiConfig {
  const prefix = task === "text" ? "AI_TEXT_" : task === "image" ? "AI_IMAGE_" : null;
  const pick = (suffix: "PROVIDER" | "BASE_URL" | "MODEL" | "API_KEY") =>
    (prefix ? env[`${prefix}${suffix}`] : undefined) ?? env[`AI_${suffix}`];

  const provider = (pick("PROVIDER") ?? "gemini") as Provider;
  const preset = provider === "custom" ? undefined : PRESETS[provider];

  const baseUrl = (pick("BASE_URL") ?? preset?.baseUrl ?? "").replace(/\/$/, "");
  const model = pick("MODEL") ?? preset?.model ?? "";
  const apiKey = pick("API_KEY") ?? "";
  // Every supported provider is a hosted endpoint that authenticates with a key.
  const configured = Boolean(baseUrl && model && apiKey);

  return {
    provider,
    label: preset?.label ?? "Custom endpoint",
    baseUrl,
    model,
    apiKey,
    configured,
  };
}

export function aiConfig(task?: AiTask): AiConfig {
  return aiConfigFromEnv(process.env, task);
}
