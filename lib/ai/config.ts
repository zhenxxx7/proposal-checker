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
    model: "gemini-2.5-flash",
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

export function aiConfig(): AiConfig {
  const provider = (process.env.AI_PROVIDER ?? "gemini") as Provider;
  const preset = provider === "custom" ? undefined : PRESETS[provider];

  const baseUrl = (process.env.AI_BASE_URL ?? preset?.baseUrl ?? "").replace(/\/$/, "");
  const model = process.env.AI_MODEL ?? preset?.model ?? "";
  const apiKey = process.env.AI_API_KEY ?? "";
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
