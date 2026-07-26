/**
 * Shared guards for the JSON POST routes. Browsers attach an Origin header to
 * every fetch POST (and Sec-Fetch-Site when Origin is omitted); plain scripted
 * clients send neither. Rejecting those keeps drive-by pages and accidental
 * external calls away from the expensive AI routes and the shared feedback
 * memory. This is abuse prevention, not authentication.
 */

export interface OriginSignals {
  origin: string | null;
  secFetchSite: string | null;
}

/** Pure decision, exported so the truth table is testable without a Request. */
export function isTrustedOriginSignal(signals: OriginSignals, expectedOrigin: string): boolean {
  if (signals.origin) return signals.origin === expectedOrigin;
  return signals.secFetchSite === "same-origin";
}

export function isTrustedOrigin(request: Request): boolean {
  return isTrustedOriginSignal(
    {
      origin: request.headers.get("origin"),
      secFetchSite: request.headers.get("sec-fetch-site"),
    },
    new URL(request.url).origin,
  );
}

export type BoundedJsonResult = { ok: true; value: unknown } | { ok: false; status: 400 | 413 };

/**
 * Reads and parses a JSON body while enforcing the cap on the actual bytes.
 * A Content-Length check alone is not enough: chunked bodies carry no header.
 */
export async function readBoundedJson(request: Request, maxBytes: number): Promise<BoundedJsonResult> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, status: 413 };

  let text = "";
  if (request.body) {
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          return { ok: false, status: 413 };
        }
        chunks.push(value);
      }
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    text = new TextDecoder().decode(merged);
  }

  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400 };
  }
}

export function boundedJsonError(status: 400 | 413): { error: string } {
  return { error: status === 413 ? "Payload too large" : "Invalid JSON" };
}
