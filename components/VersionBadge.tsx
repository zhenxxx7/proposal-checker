const VERSION = process.env.NEXT_PUBLIC_APP_VERSION;

/**
 * Fixed version tag pinned to the bottom-right corner. The string is inlined
 * from package.json at build time (see next.config.ts), so it stays in step
 * with the app version. pointer-events-none keeps it from blocking clicks on
 * whatever sits underneath.
 */
export function VersionBadge() {
  if (!VERSION) return null;
  return (
    <span
      className="pointer-events-none fixed bottom-4 right-6 z-40 select-none font-mono text-[10px] leading-none tracking-tight text-zinc-400/80 dark:text-zinc-600"
    >
      v{VERSION}
    </span>
  );
}
