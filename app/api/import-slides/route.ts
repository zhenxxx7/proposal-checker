export const maxDuration = 60;

interface Body {
  url?: string;
}

/**
 * Pulls the presentation id out of whatever the user pasted: a full edit/view
 * URL, an export URL, or a bare id. Google ids are URL-safe base64-ish.
 */
function presentationId(input: string): string | null {
  const s = input.trim();
  const inPath = s.match(/\/presentation\/d\/([a-zA-Z0-9_-]+)/);
  if (inPath) return inPath[1];
  const asParam = s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (asParam) return asParam[1];
  if (/^[a-zA-Z0-9_-]{25,}$/.test(s)) return s;
  return null;
}

/** Recover the deck's real name from the export's Content-Disposition. */
function filenameFrom(cd: string | null): string | null {
  if (!cd) return null;
  const star = cd.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1].replace(/["']/g, ""));
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = cd.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1] : null;
}

export async function POST(req: Request) {
  let url: string | undefined;
  try {
    ({ url } = (await req.json()) as Body);
  } catch {
    return Response.json({ error: "Bad request." }, { status: 400 });
  }
  if (!url?.trim()) return Response.json({ error: "Paste a Google Slides link." }, { status: 400 });

  const id = presentationId(url);
  if (!id) {
    return Response.json(
      { error: "That doesn't look like a Google Slides link. Copy the link from your browser's address bar." },
      { status: 400 },
    );
  }

  // The public export endpoint hands back a real .pptx for link-shared decks.
  // A private deck redirects to a Google sign-in HTML page instead — we detect
  // that below by the zip magic and give an actionable message.
  const exportUrl = `https://docs.google.com/presentation/d/${id}/export/pptx`;

  let res: Response;
  try {
    res = await fetch(exportUrl, {
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 (compatible; ProposalChecker/1.0)" },
    });
  } catch {
    return Response.json({ error: "Could not reach Google. Check your connection and try again." }, { status: 502 });
  }

  if (res.status === 404) {
    return Response.json({ error: "No presentation found at that link." }, { status: 404 });
  }
  if (!res.ok) {
    return Response.json({ error: `Google returned ${res.status} for that link.` }, { status: 502 });
  }

  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // Every .pptx is a zip, so it starts with "PK". Anything else — almost always
  // the HTML of a sign-in wall — means the deck is not link-shared.
  const isZip = bytes.length > 1 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!isZip) {
    return Response.json(
      {
        error:
          "This deck isn't shared publicly. In Google Slides open Share → General access → “Anyone with the link”, then paste the link again.",
      },
      { status: 403 },
    );
  }

  const name = filenameFrom(res.headers.get("content-disposition")) ?? "Google Slides.pptx";
  return new Response(buf, {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "x-filename": encodeURIComponent(name),
      "cache-control": "no-store",
    },
  });
}
