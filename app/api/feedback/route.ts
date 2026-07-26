import { isFeedbackRecord } from "@/lib/feedback";
import { saveSharedFeedback, sharedFeedbackConfigured } from "@/lib/feedbackServer";
import { boundedJsonError, hasValidFeedbackToken, isTrustedOrigin, readBoundedJson } from "@/lib/requestGuards";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 32 * 1024;
const DECK_FINGERPRINT_PATTERN = /^deck-v1-[a-f0-9]{16}$/;

export async function POST(request: Request) {
  if (!sharedFeedbackConfigured()) {
    return Response.json({ stored: false, configured: false });
  }
  if (!isTrustedOrigin(request)) return Response.json({ error: "Forbidden" }, { status: 403 });
  if (!hasValidFeedbackToken(request)) return Response.json({ error: "Forbidden" }, { status: 403 });

  const body = await readBoundedJson(request, MAX_BODY_BYTES);
  if (!body.ok) return Response.json(boundedJsonError(body.status), { status: body.status });
  const record = isObject(body.value) ? body.value.record : undefined;
  if (!isFeedbackRecord(record)) return Response.json({ error: "Invalid feedback record" }, { status: 400 });
  // Shared memory only accepts content-derived deck identities; a filename
  // fallback would let scripted requests seed the memory with arbitrary keys.
  if (!record.deck.fingerprint || !DECK_FINGERPRINT_PATTERN.test(record.deck.fingerprint)) {
    return Response.json({ error: "Invalid deck fingerprint" }, { status: 400 });
  }

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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
