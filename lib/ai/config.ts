/**
 * Every supported provider speaks the OpenAI chat-completions shape, so the
 * whole AI layer is one fetch and a base URL. Switching provider is one env var.
 */
export type Provider = "gemini" | "openrouter" | "ollama" | "custom";

interface Preset {
  baseUrl: string;
  model: string;
  needsKey: boolean;
  label: string;
}

const PRESETS: Record<Exclude<Provider, "custom">, Preset> = {
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
    needsKey: true,
    label: "Gemini",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    model: "qwen/qwen2.5-vl-72b-instruct:free",
    needsKey: true,
    label: "OpenRouter",
  },
  ollama: {
    baseUrl: "http://localhost:11434/v1",
    model: "qwen2.5vl:7b",
    needsKey: false,
    label: "Ollama (local)",
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
  // A custom base URL is assumed to be a local/self-hosted endpoint that may not need auth.
  const needsKey = process.env.AI_BASE_URL ? false : (preset?.needsKey ?? false);

  return {
    provider,
    label: preset?.label ?? "Custom endpoint",
    baseUrl,
    model,
    apiKey,
    configured: Boolean(baseUrl && model && (!needsKey || apiKey)),
  };
}
