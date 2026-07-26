import { adminConfigured } from "@/lib/adminAuth";
import { verifySession } from "@/lib/adminSession";
import { adminQueueConfigured, listApprovedForExport, rowCursor } from "@/lib/adminServer";
import { dpoRecord, exportEligible, isExportFormat, sftRecord } from "@/lib/feedbackExport";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BATCH = 500;

/** Streams approved feedback as training-ready JSONL. Approved-only, always. */
export async function GET(request: Request) {
  if (!adminConfigured() || !adminQueueConfigured()) return Response.json({ error: "Not found" }, { status: 404 });
  if (!(await verifySession())) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const format = new URL(request.url).searchParams.get("format");
  if (!isExportFormat(format)) {
    return Response.json({ error: "format must be sft or dpo" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        let before: string | undefined;
        for (;;) {
          const rows = await listApprovedForExport({ limit: BATCH, before });
          if (!rows.length) break;
          for (const row of rows) {
            if (!exportEligible(row, format)) continue;
            const record = format === "sft" ? sftRecord(row) : dpoRecord(row);
            controller.enqueue(encoder.encode(`${JSON.stringify(record)}\n`));
          }
          before = rowCursor(rows[rows.length - 1]);
          if (rows.length < BATCH) break;
        }
      } catch (error) {
        console.error("Feedback export failed", error);
        controller.error(error);
        return;
      }
      controller.close();
    },
  });

  const date = new Date().toISOString().slice(0, 10);
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="feedback-${format}-${date}.jsonl"`,
      "cache-control": "no-store",
    },
  });
}
