import { aiConfig, type AiTask } from "@/lib/ai/config";
import { promptVersionFor } from "@/lib/ai/prompts";
import { sharedFeedbackConfigured } from "@/lib/feedbackServer";
import { mintFeedbackTokenCookie } from "@/lib/requestGuards";

export const dynamic = "force-dynamic";

/** Lets the UI disable the AI button with a real reason instead of failing on click. */
export async function GET(request: Request) {
  // Piggyback the anon feedback token on the status call every page load makes.
  const tokenCookie = mintFeedbackTokenCookie(request);
  const headers = tokenCookie ? { "set-cookie": tokenCookie } : undefined;
  const { configured, provider, label, model } = aiConfig();
  return Response.json({
    configured,
    provider,
    label,
    model,
    // Per-task resolution: the text and image passes can serve from different
    // models once task-scoped env vars (or later the model registry) diverge.
    tasks: {
      text: taskStatus("text"),
      image: taskStatus("image"),
    },
    promptVersions: {
      text: promptVersionFor("ai-text"),
      image: promptVersionFor("ai-image"),
    },
    feedbackConfigured: sharedFeedbackConfigured(),
  }, { headers });
}

function taskStatus(task: AiTask) {
  const { configured, provider, label, model } = aiConfig(task);
  return { configured, provider, label, model };
}
