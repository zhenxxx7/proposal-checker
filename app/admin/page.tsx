import { redirect } from "next/navigation";
import { adminConfigured } from "@/lib/adminAuth";
import { verifySession } from "@/lib/adminSession";
import {
  adminQueueConfigured,
  countByStatus,
  groupFeedbackForReview,
  listFeedbackForReview,
  rowCursor,
  type AdminFeedbackRow,
  type ReviewStatus,
} from "@/lib/adminServer";
import { effectiveCorrection } from "@/lib/feedbackExport";
import { feedbackRequiresApproval } from "@/lib/feedbackServer";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const STATUSES: ReviewStatus[] = ["pending", "approved", "rejected"];
const STATUS_LABELS: Record<ReviewStatus, string> = {
  pending: "Training queue",
  approved: "Included in training",
  rejected: "Excluded",
};

/**
 * Server-rendered MPA review queue: forms post to /api/admin/review, which
 * 303s back here. No client JS — the data source is server-only Neon and the
 * whole page sits behind the verifySession() DAL.
 */
export default async function AdminReviewPage({ searchParams }: PageProps<"/admin">) {
  if (!(await verifySession())) redirect("/admin/login");
  if (!adminConfigured() || !adminQueueConfigured()) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-12 text-sm text-zinc-500 dark:text-zinc-400">
        The review queue needs both <code className="font-mono">ADMIN_TOKEN</code> and{" "}
        <code className="font-mono">DATABASE_URL</code> configured.
      </main>
    );
  }

  const params = await searchParams;
  const status = STATUSES.includes(params?.status as ReviewStatus) ? (params.status as ReviewStatus) : "pending";
  const before = typeof params?.before === "string" ? params.before : undefined;
  const reviewError = params?.error === "review";
  const bulkApproved = params?.notice === "bulk-approved";
  const approvalGate = feedbackRequiresApproval();
  const currentQuery = `status=${status}${before ? `&before=${encodeURIComponent(before)}` : ""}`;

  const [counts, rows] = await Promise.all([
    countByStatus(),
    listFeedbackForReview({ status, limit: PAGE_SIZE, before }),
  ]);
  const groups = groupFeedbackForReview(rows);
  const older = rows.length === PAGE_SIZE ? rowCursor(rows[rows.length - 1]) : null;

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Feedback dashboard</h1>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            Monitor collected feedback. Curate only rows you want in SFT/DPO training.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="/admin/data"
            className="rounded-md border border-indigo-200 px-2.5 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50 dark:border-indigo-900 dark:text-indigo-300 dark:hover:bg-indigo-950/40"
          >
            Data portal
          </a>
          <a
            href="/api/admin/export?format=sft"
            className="rounded-md border border-zinc-200 px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            Export SFT
          </a>
          <a
            href="/api/admin/export?format=dpo"
            className="rounded-md border border-zinc-200 px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            Export DPO
          </a>
          <form method="post" action="/api/admin/logout">
            <button className="rounded-md border border-zinc-200 px-2.5 py-1.5 text-xs font-medium text-zinc-500 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800">
              Sign out
            </button>
          </form>
        </div>
      </header>

      <section
        className={`mt-5 rounded-xl border px-4 py-3 ${
          approvalGate
            ? "border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30"
            : "border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30"
        }`}
        data-learning-mode={approvalGate ? "approval-required" : "immediate"}
      >
        <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          Gemini feedback memory: {approvalGate ? "approval required" : "active immediately"}
        </p>
        <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
          {approvalGate
            ? "Ratings are stored. Approved rows only add bounded prompt guidance and enter training exports."
            : "Ratings add bounded prompt guidance on later runs; Gemini weights never change. Approve rows only for SFT/DPO training exports."}
        </p>
      </section>

      <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-3">
        {STATUSES.map((tab) => (
          <a
            key={tab}
            href={`/admin?status=${tab}`}
            className={`rounded-lg border px-3 py-2 ${
              tab === status
                ? "border-indigo-400 bg-indigo-50 dark:border-indigo-600 dark:bg-indigo-950/40"
                : "border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800"
            }`}
            data-review-tab={tab}
          >
            <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">{STATUS_LABELS[tab]}</span>
            <span className="mt-0.5 block text-lg font-semibold text-zinc-900 dark:text-zinc-100">{counts[tab]}</span>
          </a>
        ))}
      </div>

      {status === "pending" && counts.pending > 0 && (
        <form method="post" action="/api/admin/review" className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2.5 dark:border-indigo-900 dark:bg-indigo-950/30">
          <input type="hidden" name="action" value="approve-pending" />
          <input type="hidden" name="redirect" value="status=pending" />
          <p className="min-w-0 flex-1 text-xs text-indigo-950 dark:text-indigo-100">
            Ready to curate in batch? This includes all {counts.pending} pending row(s) in SFT/DPO exports.
          </p>
          <button className="rounded-md bg-indigo-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-500">
            Include all in training
          </button>
        </form>
      )}

      {reviewError && (
        <p
          data-review-error
          className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
        >
          Saving that review failed — the database did not confirm the change. Try again.
        </p>
      )}
      {bulkApproved && (
        <p className="mt-4 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
          Pending feedback included in training.
        </p>
      )}

      {groups.length === 0 ? (
        <p className="mt-10 text-sm text-zinc-500 dark:text-zinc-400" data-review-empty>
          No {STATUS_LABELS[status].toLowerCase()} feedback.
        </p>
      ) : (
        <div className="mt-6 flex flex-col gap-6">
          {groups.map((group) => (
            <section
              key={group.learningKey}
              data-review-group={group.learningKey}
              className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
            >
              <div className="border-b border-zinc-100 px-4 py-2.5 text-[11px] text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
                pattern <span className="font-mono">{group.learningKey.slice(0, 34)}…</span> · {group.rows.length}{" "}
                event(s)
              </div>
              <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {group.rows.map((row) => (
                  <ReviewRow key={row.id} row={row} currentQuery={currentQuery} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {older && (
        <div className="mt-6">
          <a
            href={`/admin?status=${status}&before=${encodeURIComponent(older)}`}
            className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            Older →
          </a>
        </div>
      )}
    </main>
  );
}

function ReviewRow({ row, currentQuery }: { row: AdminFeedbackRow; currentQuery: string }) {
  const finding = (row.finding ?? {}) as Record<string, unknown>;
  const quote = typeof finding.quote === "string" ? finding.quote : "";
  const suggestion = typeof finding.suggestion === "string" ? finding.suggestion : "";
  const detail = typeof finding.detail === "string" ? finding.detail : "";
  const correction = effectiveCorrection(row);
  const needsCorrection = row.rating === "not-useful" && !correction;

  return (
    <div className="px-4 py-3" data-review-row={row.id}>
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span
          className={`rounded-full px-2 py-0.5 font-medium ${
            row.rating === "useful"
              ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
              : "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300"
          }`}
        >
          {row.rating}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 font-medium ${
            row.review_status === "approved"
              ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300"
              : row.review_status === "rejected"
                ? "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                : "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300"
          }`}
        >
          {STATUS_LABELS[row.review_status]}
        </span>
        <span className="text-zinc-400">{row.source}</span>
        <span className="text-zinc-400">{row.category}</span>
        <span className="font-mono text-zinc-400">{row.deck_fingerprint.slice(0, 16)}</span>
        <span className="text-zinc-400">
          {row.server_provider ?? row.provider ?? "?"} · {row.server_model ?? row.model ?? "?"} ·{" "}
          {row.prompt_version ?? "no prompt version"}
        </span>
        {needsCorrection && (
          <span
            data-needs-correction
            className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-700 dark:bg-amber-950/60 dark:text-amber-300"
          >
            needs a correction to be trainable
          </span>
        )}
      </div>

      <p className="mt-1.5 text-sm text-zinc-800 dark:text-zinc-200">{detail}</p>
      {quote && (
        <p className="mt-1 font-mono text-xs text-zinc-600 dark:text-zinc-400">
          “{quote}” → {suggestion || "—"}
        </p>
      )}
      {row.reason && <p className="mt-1 text-xs italic text-zinc-500">User comment: {row.reason}</p>}
      {row.review_note && <p className="mt-1 text-xs text-zinc-500">Note: {row.review_note}</p>}

      <details className="mt-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800" open={row.review_status === "pending" && needsCorrection}>
        <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-zinc-600 dark:text-zinc-300">
          {row.review_status === "pending" ? "Choose training status" : "Change training status / annotation"}
        </summary>
        <form method="post" action="/api/admin/review" className="flex flex-col gap-2 border-t border-zinc-100 p-3 dark:border-zinc-800">
          <input type="hidden" name="id" value={row.id} />
          <input type="hidden" name="redirect" value={currentQuery} />
          <details open={Boolean(correction) || needsCorrection}>
            <summary className="cursor-pointer text-[11px] text-zinc-500 dark:text-zinc-400">
              Add training correction (optional)
            </summary>
            <textarea
              name="correction"
              rows={2}
              maxLength={4000}
              defaultValue={correction ?? ""}
              placeholder="What should the finding have said?"
              className="mt-2 w-full resize-y rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-800 outline-none focus:border-indigo-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
            />
          </details>
          <input
            name="note"
            maxLength={2000}
            placeholder="Internal note (optional)"
            className="w-full rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-800 outline-none focus:border-indigo-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
          />
          <div className="flex flex-wrap items-center gap-2">
            {row.review_status !== "approved" && (
              <button
                name="decision"
                value="approved"
                className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500"
              >
                Include in training
              </button>
            )}
            {row.review_status !== "rejected" && (
              <button
                name="decision"
                value="rejected"
                className="rounded-md bg-rose-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-rose-500"
              >
                Exclude from training
              </button>
            )}
            {row.review_status !== "pending" && (
              <button
                name="decision"
                value="pending"
                className="rounded-md border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Return to queue
              </button>
            )}
          </div>
        </form>
      </details>
    </div>
  );
}
