const PPTX_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const MAX_BYTES = 250 * 1024 * 1024;

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const requestId = crypto.randomUUID().slice(0, 8);
  console.info(`[google-slides:${requestId}] import requested`);

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    console.warn(`[google-slides:${requestId}] invalid JSON body`);
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const link = typeof input === "object" && input !== null && "url" in input
    ? String((input as { url: unknown }).url).trim()
    : "";
  const presentationId = googleSlidesId(link);
  if (!presentationId) {
    console.warn(`[google-slides:${requestId}] unsupported link format`);
    return Response.json(
      {
        error: isPublishedLink(link)
          ? "Use the Google Slides Share link, not the Publish to web link."
          : "Paste a Google Slides or Google Drive share link.",
      },
      { status: 400 },
    );
  }

  const exportUrl = `https://docs.google.com/presentation/d/${presentationId}/export/pptx`;

  try {
    const upstream = await fetch(exportUrl, {
      cache: "no-store",
      redirect: "follow",
      headers: {
        accept: `${PPTX_TYPE}, application/octet-stream;q=0.9, */*;q=0.1`,
        "accept-encoding": "identity",
        "user-agent": "Mozilla/5.0 ProposalChecker/1.0",
      },
    });

    if (!upstream.ok || !upstream.body) {
      console.warn(`[google-slides:${requestId}] Google export failed`, { status: upstream.status });
      return googleAccessError(upstream.status);
    }

    const contentLength = upstream.headers.get("content-length");
    const contentEncoding = upstream.headers.get("content-encoding");
    const announcedBytes = contentLength === null || (contentEncoding && contentEncoding !== "identity")
      ? null
      : Number(contentLength);
    if (announcedBytes !== null && Number.isFinite(announcedBytes) && announcedBytes > MAX_BYTES) {
      await upstream.body.cancel();
      return Response.json({ error: "This presentation is larger than 250MB." }, { status: 413 });
    }

    const reader = upstream.body.getReader();
    const initial: Uint8Array[] = [];
    let initialBytes = 0;
    while (initialBytes < 4) {
      const chunk = await reader.read();
      if (chunk.done) break;
      initial.push(chunk.value);
      initialBytes += chunk.value.byteLength;
    }
    const signature = initial.length === 1
      ? initial[0]
      : Uint8Array.from(initial.flatMap((chunk) => [...chunk]));
    if (signature.length < 2 || signature[0] !== 0x50 || signature[1] !== 0x4b) {
      await reader.cancel();
      console.warn(`[google-slides:${requestId}] Google returned a non-PPTX response`);
      return googleAccessError(upstream.status);
    }

    let transferred = initialBytes;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of initial) controller.enqueue(chunk);
      },
      async pull(controller) {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          return;
        }
        transferred += chunk.value.byteLength;
        if (transferred > MAX_BYTES) {
          await reader.cancel("Presentation exceeds 250MB");
          controller.error(new Error("Presentation exceeds 250MB"));
          return;
        }
        controller.enqueue(chunk.value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });

    const fileName = exportedFileName(upstream.headers.get("content-disposition"));
    console.info(`[google-slides:${requestId}] export started`, {
      bytes: announcedBytes,
      fileName,
    });
    return new Response(stream, {
      headers: {
        "cache-control": "private, no-store",
        "content-type": PPTX_TYPE,
        "content-disposition": `attachment; filename="${asciiFileName(fileName)}"`,
        "x-file-name": encodeURIComponent(fileName),
        ...(announcedBytes !== null && Number.isFinite(announcedBytes)
          ? { "content-length": String(announcedBytes) }
          : {}),
      },
    });
  } catch (error) {
    console.error(`[google-slides:${requestId}] import failed`, error);
    return Response.json(
      { error: "Google Slides could not be reached. Try again." },
      { status: 502 },
    );
  }
}

function googleSlidesId(value: string): string | null {
  if (!value || value.length > 8192) return null;
  const candidates = [value.trim(), ...(value.match(/https:\/\/[^\s<>"']+/gi) ?? [])];

  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (url.protocol !== "https:") continue;

      if (url.hostname === "docs.google.com") {
        const match = url.pathname.match(/^\/presentation\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,})(?:\/|$)/);
        const queryId = url.pathname === "/open" ? url.searchParams.get("id") : null;
        if (match?.[1]) return match[1];
        if (queryId && /^[A-Za-z0-9_-]{10,}$/.test(queryId)) return queryId;
      }

      if (url.hostname === "drive.google.com") {
        const match = url.pathname.match(/^\/file\/d\/([A-Za-z0-9_-]{10,})(?:\/|$)/);
        const queryId = url.searchParams.get("id");
        if (match?.[1]) return match[1];
        if (queryId && /^[A-Za-z0-9_-]{10,}$/.test(queryId)) return queryId;
      }
    } catch {
      // Try the next URL found in pasted share text.
    }
  }

  return null;
}

function isPublishedLink(value: string): boolean {
  return /docs\.google\.com\/presentation\/(?:u\/\d+\/)?d\/e\//i.test(value);
}

function googleAccessError(status: number) {
  if (status === 429) {
    return Response.json({ error: "Google is rate-limiting exports. Wait a moment and try again." }, { status: 429 });
  }
  if (status >= 500) {
    return Response.json({ error: "Google Slides export is temporarily unavailable. Try again." }, { status: 502 });
  }
  return Response.json(
    {
      error:
        status === 404
          ? "Google Slides presentation was not found."
          : "Google could not export this presentation. Share it as 'Anyone with the link' and allow viewers to download.",
    },
    { status: status === 404 ? 404 : 403 },
  );
}

function exportedFileName(disposition: string | null): string {
  const encoded = disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = disposition?.match(/filename="?([^";]+)"?/i)?.[1];
  let candidate = "Google Slides presentation.pptx";
  try {
    if (encoded) candidate = decodeURIComponent(encoded);
    else if (plain) candidate = plain;
  } catch {
    // Keep the safe fallback.
  }
  const safe = candidate.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 180);
  return safe.toLowerCase().endsWith(".pptx") ? safe : `${safe || "Google Slides presentation"}.pptx`;
}

function asciiFileName(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
}
