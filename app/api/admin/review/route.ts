import { adminConfigured } from "@/lib/adminAuth";
import { verifySession } from "@/lib/adminSession";
import { adminQueueConfigured, reviewFeedback, type ReviewDecision } from "@/lib/adminServer";
import { isTrustedOrigin } from "@/lib/requestGuards";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 16 * 1024;
const DECISIONS = new Set<ReviewDecision>(["approved", "rejected", "pending"]);

export async function POST(request: Request) {
  if (!adminConfigured() || !adminQueueConfigured()) return Response.json({ error: "Not found" }, { status: 404 });
  if (!(await verifySession())) return redirect(request, "/admin/login");
  if (!isTrustedOrigin(request)) return Response.json({ error: "Forbidden" }, { status: 403 });
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) {
    return Response.json({ error: "Payload too large" }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "Invalid form" }, { status: 400 });
  }
  const id = String(form.get("id") ?? "");
  const decision = String(form.get("decision") ?? "") as ReviewDecision;
  const note = String(form.get("note") ?? "").slice(0, 2000);
  const correction = String(form.get("correction") ?? "").slice(0, 4000);
  const back = sanitizeQuery(String(form.get("redirect") ?? ""));
  if (!id || id.length > 128 || !DECISIONS.has(decision)) {
    return Response.json({ error: "Invalid review request" }, { status: 400 });
  }

  try {
    const found = await reviewFeedback({ id, decision, note, correction });
    if (!found) return Response.json({ error: "Unknown feedback id" }, { status: 404 });
    return redirect(request, `/admin${back ? `?${back}` : ""}`);
  } catch (error) {
    console.error("Feedback review failed", error);
    // The admin must SEE a failure — never fake success on the operator surface.
    return redirect(request, `/admin?${back ? `${back}&` : ""}error=review`);
  }
}

/** Only a same-page query string may round-trip through the form. */
function sanitizeQuery(value: string): string {
  return /^[A-Za-z0-9=&%._|:-]{0,300}$/.test(value) ? value : "";
}

function redirect(request: Request, path: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location: new URL(path, request.url).toString() },
  });
}
