import { aiConfig } from "@/lib/ai/config";

export const dynamic = "force-dynamic";

/** Lets the UI disable the AI button with a real reason instead of failing on click. */
export async function GET() {
  const { configured, provider, label, model } = aiConfig();
  return Response.json({ configured, provider, label, model });
}
