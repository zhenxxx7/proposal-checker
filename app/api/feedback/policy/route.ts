import { isFeedbackPolicyRequest } from "@/lib/feedback";
import { resolveSharedFeedbackPolicy, sharedFeedbackConfigured } from "@/lib/feedbackServer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 64 * 1024;

export async function POST(request: Request) {
  if (!sharedFeedbackConfigured()) return Response.json(emptyPolicy());
  if (!isSameOrigin(request)) return Response.json({ error: "Forbidden" }, { status: 403 });
  if (contentLengthTooLarge(request)) return Response.json({ error: "Payload too large" }, { status: 413 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!isFeedbackPolicyRequest(body)) return Response.json({ error: "Invalid feedback policy request" }, { status: 400 });

  try {
    return Response.json(await resolveSharedFeedbackPolicy(body));
  } catch (error) {
    console.error("Shared feedback policy lookup failed", error);
    // Returning the empty policy preserves local fallback without turning a
    // transient database problem into a browser console/network error.
    return Response.json(emptyPolicy());
  }
}

function emptyPolicy() {
  return { configured: false, suppressedLearningKeys: [], selections: {} };
}

function contentLengthTooLarge(request: Request): boolean {
  const value = Number(request.headers.get("content-length"));
  return Number.isFinite(value) && value > MAX_BODY_BYTES;
}

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}
