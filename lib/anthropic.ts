import Anthropic from "@anthropic-ai/sdk";
import { FINDINGS_SCHEMA, type AiFinding } from "./aiSchema";

export const MODEL = "claude-opus-4-8";

let cached: Anthropic | null = null;

/** The SDK resolves ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / an `ant auth login` profile. */
export function anthropic(): Anthropic {
  if (!cached) cached = new Anthropic();
  return cached;
}

type Block = Anthropic.ContentBlockParam;

/**
 * One structured-output call. Returns [] on refusal rather than throwing —
 * a single unreadable mockup should not sink a 56-slide audit.
 */
export async function askForFindings(system: string, content: Block[]): Promise<AiFinding[]> {
  const res = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 16000,
    system,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: FINDINGS_SCHEMA },
    },
    messages: [{ role: "user", content }],
  });

  if (res.stop_reason === "refusal") return [];

  const text = res.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") return [];

  try {
    const parsed = JSON.parse(text.text) as { findings?: AiFinding[] };
    return parsed.findings ?? [];
  } catch {
    return [];
  }
}
