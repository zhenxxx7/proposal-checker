export const dynamic = "force-dynamic";

/** Lets the UI disable the AI button with a real reason instead of failing on click. */
export async function GET() {
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  return Response.json({ hasKey });
}
