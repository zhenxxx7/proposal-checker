import { redirect } from "next/navigation";
import { adminConfigured } from "@/lib/adminAuth";
import { verifySession } from "@/lib/adminSession";

export const dynamic = "force-dynamic";

export default async function AdminLoginPage({ searchParams }: PageProps<"/admin/login">) {
  if (await verifySession()) redirect("/admin");
  const params = await searchParams;
  const failed = params?.error === "1";

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 dark:bg-zinc-950">
      <div className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Reviewer sign-in</h1>
        {!adminConfigured() ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
            Admin review is not configured. Set the <code className="font-mono">ADMIN_TOKEN</code> environment
            variable to enable it.
          </p>
        ) : (
          <form method="post" action="/api/admin/session" className="mt-4 flex flex-col gap-3">
            <label className="flex flex-col gap-1.5 text-sm text-zinc-600 dark:text-zinc-300">
              Admin token
              <input
                type="password"
                name="token"
                required
                autoFocus
                autoComplete="current-password"
                className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-indigo-500 dark:focus:ring-indigo-950"
              />
            </label>
            {failed && (
              <p data-login-error className="text-sm text-amber-600 dark:text-amber-400">
                That token was not accepted.
              </p>
            )}
            <button
              type="submit"
              className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-indigo-500"
            >
              Sign in
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
