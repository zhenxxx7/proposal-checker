import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_PURPOSE,
  ADMIN_SESSION_TTL_MS,
  adminConfigured,
  createSignedExpiryToken,
  secretsMatch,
  serializeCookie,
} from "@/lib/adminAuth";
import { isTrustedOrigin } from "@/lib/requestGuards";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 4 * 1024;

export async function POST(request: Request) {
  // 404, not 403: an unconfigured admin surface should not advertise itself.
  if (!adminConfigured()) return Response.json({ error: "Not found" }, { status: 404 });
  if (!isTrustedOrigin(request)) return Response.json({ error: "Forbidden" }, { status: 403 });
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) {
    return Response.json({ error: "Payload too large" }, { status: 413 });
  }

  let candidate = "";
  try {
    const form = await request.formData();
    candidate = String(form.get("token") ?? "");
  } catch {
    return redirect(request, "/admin/login?error=1");
  }

  // One 303 for every failure: no oracle between wrong and malformed tokens.
  if (!candidate || !secretsMatch(candidate, process.env.ADMIN_TOKEN ?? "")) {
    return redirect(request, "/admin/login?error=1");
  }

  const cookie = serializeCookie(
    ADMIN_SESSION_COOKIE,
    createSignedExpiryToken(process.env.ADMIN_TOKEN ?? "", ADMIN_SESSION_PURPOSE, ADMIN_SESSION_TTL_MS, Date.now()),
    Math.floor(ADMIN_SESSION_TTL_MS / 1000),
    new URL(request.url).protocol === "https:",
  );
  return redirect(request, "/admin", cookie);
}

function redirect(request: Request, path: string, cookie?: string): Response {
  const headers = new Headers({ location: new URL(path, request.url).toString() });
  if (cookie) headers.set("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}
