import { isFeedbackPolicyRequest } from "@/lib/feedback";
import { resolveSharedFeedbackPolicy, sharedFeedbackConfigured } from "@/lib/feedbackServer";
import { boundedJsonError, hasValidFeedbackToken, isTrustedOrigin, readBoundedJson } from "@/lib/requestGuards";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 64 * 1024;

export async function POST(request: Request) {
  if (!sharedFeedbackConfigured()) return Response.json(emptyPolicy());
  if (!isTrustedOrigin(request)) return Response.json({ error: "Forbidden" }, { status: 403 });
  if (!hasValidFeedbackToken(request)) return Response.json(emptyPolicy());

  const body = await readBoundedJson(request, MAX_BODY_BYTES);
  if (!body.ok) return Response.json(boundedJsonError(body.status), { status: body.status });
  if (!isFeedbackPolicyRequest(body.value)) {
    return Response.json({ error: "Invalid feedback policy request" }, { status: 400 });
  }

  try {
    return Response.json(await resolveSharedFeedbackPolicy(body.value));
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
