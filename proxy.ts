import { ADMIN_SESSION_COOKIE, ADMIN_SESSION_PURPOSE, cookieValue, verifySignedExpiryToken } from "@/lib/adminAuth";

/**
 * Optimistic redirect only: sends cookie-less visitors of /admin/* to the
 * login page. This is UX, not security — the authoritative check is
 * verifySession() inside every admin page and route handler, because Server
 * Functions and direct fetches bypass proxy matcher exclusions.
 */
export function proxy(request: Request) {
  const url = new URL(request.url);
  if (url.pathname === "/admin/login") return;

  const token = process.env.ADMIN_TOKEN;
  const session = cookieValue(request.headers.get("cookie"), ADMIN_SESSION_COOKIE);
  if (token && verifySignedExpiryToken(token, ADMIN_SESSION_PURPOSE, session, Date.now())) return;

  return Response.redirect(new URL("/admin/login", request.url), 307);
}

export const config = {
  matcher: ["/admin/:path*"],
};
