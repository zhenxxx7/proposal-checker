import { isFeedbackRecord } from "@/lib/feedback";
import { saveSharedFeedback, sharedFeedbackConfigured } from "@/lib/feedbackServer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 32 * 1024;

export async function POST(request: Request) {
  if (!sharedFeedbackConfigured()) {
    return Response.json({ stored: false, configured: false });
  }
  if (!isSameOrigin(request)) return Response.json({ error: "Forbidden" }, { status: 403 });
  if (contentLengthTooLarge(request)) return Response.json({ error: "Payload too large" }, { status: 413 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const record = isObject(body) ? body.record : undefined;
  if (!isFeedbackRecord(record)) return Response.json({ error: "Invalid feedback record" }, { status: 400 });

  try {
    await saveSharedFeedback(record);
    return Response.json({ stored: true, configured: true }, { status: 201 });
  } catch (error) {
    console.error("Shared feedback write failed", error);
    // Local browser learning remains the fallback; a temporary database outage
    // should not surface as a browser console/network error to the reviewer.
    return Response.json({ stored: false, configured: true });
  }
}

function contentLengthTooLarge(request: Request): boolean {
  const value = Number(request.headers.get("content-length"));
  return Number.isFinite(value) && value > MAX_BODY_BYTES;
}

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
