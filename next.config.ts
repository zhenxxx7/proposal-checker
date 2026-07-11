import { execSync } from "node:child_process";
import type { NextConfig } from "next";
import { version } from "./package.json";

/**
 * Derived from git history using Conventional Commit prefixes, so no one ever
 * edits a version by hand: `feat:` bumps minor, `feat!:`/`BREAKING CHANGE`
 * bumps major, anything else bumps patch. Seeded at 0.1.0 for the commits
 * that predate the convention. Falls back to the commit SHA on shallow
 * clones (Vercel) and to package.json when git is unavailable.
 */
function appVersion(): string {
  try {
    if (process.env.VERCEL_GIT_COMMIT_SHA) {
      const [major, minor] = version.split(".");
      return `${major}.${minor}.${process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7)}`;
    }
    // %x1f separates subject from body, %x1e separates commits.
    const log = execSync("git log --reverse --format=%s%x1f%b%x1e", {
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 32 * 1024 * 1024,
    }).toString();
    let major = 0, minor = 1, patch = 0;
    for (const entry of log.split("\x1e")) {
      const [subject = "", body = ""] = entry.split("\x1f");
      if (!subject.trim()) continue;
      if (/^\w+(\(.+\))?!:/.test(subject) || body.includes("BREAKING CHANGE")) {
        major += 1; minor = 0; patch = 0;
      } else if (/^feat(\(.+\))?:/i.test(subject)) {
        minor += 1; patch = 0;
      } else {
        patch += 1;
      }
    }
    return `${major}.${minor}.${patch}`;
  } catch {
    return version;
  }
}

const nextConfig: NextConfig = {
  allowedDevOrigins: ["100.92.11.120", "zhenx-1.tail790cd1.ts.net", "*.tail790cd1.ts.net"],
  reactCompiler: true,
  // Inlined at build so the badge always shows the current build's version.
  env: { NEXT_PUBLIC_APP_VERSION: appVersion() },
};

export default nextConfig;
