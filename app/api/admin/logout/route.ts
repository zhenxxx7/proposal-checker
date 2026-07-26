import { ADMIN_SESSION_COOKIE, adminConfigured, serializeCookie } from "@/lib/adminAuth";
import { isTrustedOrigin } from "@/lib/requestGuards";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!adminConfigured()) return Response.json({ error: "Not found" }, { status: 404 });
  if (!isTrustedOrigin(request)) return Response.json({ error: "Forbidden" }, { status: 403 });

  const headers = new Headers({ location: new URL("/admin/login", request.url).toString() });
  headers.set("set-cookie", serializeCookie(ADMIN_SESSION_COOKIE, "", 0, new URL(request.url).protocol === "https:"));
  return new Response(null, { status: 303, headers });
}
