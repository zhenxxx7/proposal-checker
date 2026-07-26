import {
  createFeedbackPolicyRequest,
  isFeedbackPolicyResponse,
  type FeedbackDeckIdentity,
  type FeedbackPolicyResponse,
  type FeedbackRecord,
} from "./feedback";
import type { Finding } from "./types";

const EMPTY_POLICY: FeedbackPolicyResponse = {
  configured: false,
  suppressedLearningKeys: [],
  selections: {},
};

/**
 * A permanent-memory lookup is best-effort. Local browser learning remains a
 * safe fallback when the database has not been provisioned or is unavailable.
 */
export async function resolveSharedFeedbackPolicy(
  deck: FeedbackDeckIdentity,
  findings: readonly Finding[],
  signal?: AbortSignal,
): Promise<FeedbackPolicyResponse> {
  const request = createFeedbackPolicyRequest(deck, findings);
  if (!request.patterns.length) return EMPTY_POLICY;

  try {
    const response = await fetch("/api/feedback/policy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) return EMPTY_POLICY;
    const body: unknown = await response.json();
    return isFeedbackPolicyResponse(body) ? body : EMPTY_POLICY;
  } catch {
    return EMPTY_POLICY;
  }
}

/** Returns true only when the Vercel/Neon route durably accepted the rating. */
export async function storeSharedFeedbackRecord(record: FeedbackRecord): Promise<boolean> {
  try {
    const response = await fetch("/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ record }),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { stored?: unknown };
    return body.stored === true;
  } catch {
    return false;
  }
}
