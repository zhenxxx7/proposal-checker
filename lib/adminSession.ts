import { cookies } from "next/headers";
import { cache } from "react";
import { ADMIN_SESSION_COOKIE, ADMIN_SESSION_PURPOSE, verifySignedExpiryToken } from "./adminAuth";

/**
 * The real auth gate. proxy.ts only redirects for UX — every admin page and
 * route handler must call this, because Server Functions and direct fetches
 * bypass proxy matcher exclusions in Next 16. Memoized per request.
 */
export const verifySession = cache(async (): Promise<boolean> => {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return false;
  const store = await cookies();
  return verifySignedExpiryToken(token, ADMIN_SESSION_PURPOSE, store.get(ADMIN_SESSION_COOKIE)?.value, Date.now());
});
