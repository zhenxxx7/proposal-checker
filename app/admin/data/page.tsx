import { redirect } from "next/navigation";
import { adminConfigured } from "@/lib/adminAuth";
import { verifySession } from "@/lib/adminSession";
import { listFeedbackForDecks, type AdminFeedbackRow } from "@/lib/adminServer";
import {
  countDeckCaptures,
  deckCaptureConfigured,
  deckRowCursor,
  listDeckCaptures,
  type DeckCaptureRow,
} from "@/lib/deckServer";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

export default async function AdminDataPage({ searchParams }: PageProps<"/admin/data">) {
  if (!(await verifySession())) redirect("/admin/login");
  if (!adminConfigured() || !deckCaptureConfigured()) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-12 text-sm text-zinc-500 dark:text-zinc-400">
        The data portal needs both <code className="font-mono">ADMIN_TOKEN</code> and{" "}
        <code className="font-mono">DATABASE_URL</code> configured.
      </main>
    );
  }

  const params = await searchParams;
  const before = typeof params?.before === "string" ? params.before : undefined;
  const [total, decks] = await Promise.all([
    countDeckCaptures(),
    listDeckCaptures({ limit: PAGE_SIZE, before }),
  ]);
  const feedback = await listFeedbackForDecks(decks.map((deck) => deck.deck_fingerprint));
  const feedbackByDeck = new Map<string, AdminFeedbackRow[]>();
  for (const row of feedback) {
    const current = feedbackByDeck.get(row.deck_fingerprint);
    if (current) current.push(row);
    else feedbackByDeck.set(row.deck_fingerprint, [row]);
  }
  const older = decks.length === PAGE_SIZE ? deckRowCursor(decks[decks.length - 1]) : null;

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <a href="/admin" className="hover:text-indigo-600 dark:hover:text-indigo-400">Feedback dashboard</a>
            <span>/</span>
            <span>Data portal</span>
          </div>
          <h1 className="mt-2 text-xl font-semibold text-zinc-900 dark:text-zinc-100">Deck and feedback data</h1>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            {total} upload/import event(s). Text and metadata are stored for tuning; raw PPTX and image pixels are not.
          </p>
        </div>
        <form method="post" action="/api/admin/logout">
          <button className="rounded-md border border-zinc-200 px-2.5 py-1.5 text-xs font-medium text-zinc-500 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800">
            Sign out
          </button>
        </form>
      </header>

      {decks.length === 0 ? (
        <p className="mt-10 text-sm text-zinc-500 dark:text-zinc-400">No deck events recorded yet.</p>
      ) : (
        <div className="mt-6 flex flex-col gap-4">
          {decks.map((deck) => (
            <DeckEvent key={deck.id} deck={deck} feedback={feedbackByDeck.get(deck.deck_fingerprint) ?? []} />
          ))}
        </div>
      )}

      {older && (
        <div className="mt-6">
          <a
            href={`/admin/data?before=${encodeURIComponent(older)}`}
            className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            Older →
          </a>
        </div>
      )}
    </main>
  );
}

function DeckEvent({ deck, feedback }: { deck: DeckCaptureRow; feedback: AdminFeedbackRow[] }) {
  const slides = Array.isArray(deck.slides) ? deck.slides : [];
  const useful = feedback.filter((row) => row.rating === "useful").length;
  const notUseful = feedback.filter((row) => row.rating === "not-useful").length;

  return (
    <article className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900" data-deck-event={deck.id}>
      <header className="border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className="rounded-full bg-indigo-50 px-2 py-0.5 font-medium text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300">
            {deck.source === "google-slides" ? "Google Slides" : "PPTX upload"}
          </span>
          <span className="text-zinc-400">{formatDate(deck.created_at)}</span>
          <span className="font-mono text-zinc-400">{deck.deck_fingerprint}</span>
        </div>
        <h2 className="mt-1.5 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{deck.name}</h2>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          {deck.slide_count} slides · {feedback.length} feedback · useful {useful} · not useful {notUseful}
        </p>
        {deck.source_url && (
          <a
            href={deck.source_url}
            target="_blank"
            rel="noreferrer"
            className="mt-2 block truncate text-xs text-indigo-600 hover:underline dark:text-indigo-400"
          >
            {deck.source_url}
          </a>
        )}
      </header>

      <details className="border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
        <summary className="cursor-pointer text-xs font-medium text-zinc-700 dark:text-zinc-300">
          Show extracted slide data ({slides.length})
        </summary>
        <div className="mt-3 flex flex-col gap-2">
          {slides.map((slide, index) => {
            const value = objectValue(slide);
            const texts = arrayOfStrings(value?.texts);
            return (
              <div key={`${deck.id}-${index}`} className="rounded-md bg-zinc-50 px-3 py-2 dark:bg-zinc-950">
                <p className="text-[11px] font-semibold text-zinc-600 dark:text-zinc-300">
                  Slide {numberValue(value?.index) ?? index + 1} · {numberValue(value?.shapeCount) ?? 0} shapes · {numberValue(value?.imageCount) ?? 0} images
                </p>
                <p className="mt-1 whitespace-pre-wrap text-xs text-zinc-600 dark:text-zinc-400">
                  {texts.length ? texts.join("\n") : "(no extracted text)"}
                </p>
              </div>
            );
          })}
        </div>
      </details>

      <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {feedback.map((row) => (
          <FeedbackEvent key={row.id} row={row} />
        ))}
        {!feedback.length && <p className="px-4 py-3 text-xs text-zinc-400">No feedback for this deck yet.</p>}
      </div>
    </article>
  );
}

function FeedbackEvent({ row }: { row: AdminFeedbackRow }) {
  const finding = objectValue(row.finding);
  const quote = stringValue(finding?.quote);
  const suggestion = stringValue(finding?.suggestion);
  const detail = stringValue(finding?.detail);
  return (
    <div className="px-4 py-3" data-feedback-event={row.id}>
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className={row.rating === "useful" ? "font-medium text-emerald-600" : "font-medium text-rose-600"}>
          {row.rating}
        </span>
        <span className="text-zinc-400">{row.review_status}</span>
        <span className="text-zinc-400">{row.source}</span>
        <span className="text-zinc-400">slide {numberValue(finding?.slide) ?? "?"}</span>
        <span className="text-zinc-400">{formatDate(row.received_at)}</span>
      </div>
      <p className="mt-1 text-xs text-zinc-700 dark:text-zinc-300">{detail || "(no detail)"}</p>
      {(quote || suggestion) && <p className="mt-1 font-mono text-[11px] text-zinc-500">“{quote}” → {suggestion || "—"}</p>}
      {row.reason && <p className="mt-1 text-xs italic text-zinc-500">Comment: {row.reason}</p>}
      {row.correction && <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-400">Correction: {row.correction}</p>}
    </div>
  );
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatDate(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : String(value);
}
