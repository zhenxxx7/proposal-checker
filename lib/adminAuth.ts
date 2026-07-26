import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Single-admin auth with zero dependencies. ADMIN_TOKEN is both the login
 * password and the root of the signing key, so rotating it invalidates every
 * outstanding session at once. Pure token functions live here (testable
 * without a request); the cookies()-based DAL lives in lib/adminSession.ts.
 */

export const ADMIN_SESSION_COOKIE = "admin_session";
export const ADMIN_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const ADMIN_SESSION_PURPOSE = "admin-session";

export const FEEDBACK_TOKEN_COOKIE = "feedback_token";
export const FEEDBACK_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export const FEEDBACK_TOKEN_PURPOSE = "feedback-anon";

export function adminConfigured(): boolean {
  return Boolean(process.env.ADMIN_TOKEN);
}

function signingKey(secret: string, purpose: string): Buffer {
  return createHmac("sha256", secret).update(`proposal-checker:${purpose}:v1`).digest();
}

/** `v1.<expiresMs>.<base64url mac>` — no payload beyond expiry, nothing to leak. */
export function createSignedExpiryToken(secret: string, purpose: string, ttlMs: number, nowMs: number): string {
  const expires = nowMs + ttlMs;
  const mac = createHmac("sha256", signingKey(secret, purpose)).update(`v1.${expires}`).digest("base64url");
  return `v1.${expires}.${mac}`;
}

export function verifySignedExpiryToken(
  secret: string,
  purpose: string,
  value: string | null | undefined,
  nowMs: number,
): boolean {
  if (!value) return false;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !/^\d{1,16}$/.test(parts[1])) return false;
  const expires = Number(parts[1]);
  if (!Number.isFinite(expires) || expires < nowMs) return false;
  const expected = createHmac("sha256", signingKey(secret, purpose)).update(`v1.${expires}`).digest();
  const actual = Buffer.from(parts[2], "base64url");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** Compare secrets by digest so a length mismatch never leaks timing. */
export function secretsMatch(candidate: string, expected: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(candidate).digest(),
    createHash("sha256").update(expected).digest(),
  );
}

export function serializeCookie(name: string, value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

/** Reads one cookie from a raw Cookie header without a parser dependency. */
export function cookieValue(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}
