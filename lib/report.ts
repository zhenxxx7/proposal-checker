import type { Finding, Severity } from "./types";

const ICON: Record<Severity, string> = { error: "🔴", warn: "🟡", info: "🔵" };

export function toMarkdown(fileName: string, slideCount: number, findings: Finding[]): string {
  const counts = tally(findings);
  const bySlide = new Map<number, Finding[]>();
  for (const f of findings) (bySlide.get(f.slide) ?? bySlide.set(f.slide, []).get(f.slide)!).push(f);

  const lines: string[] = [
    `# Proposal check — ${fileName}`,
    ``,
    `${slideCount} slides · ${counts.error} blocking · ${counts.warn} to review · ${counts.info} minor`,
    ``,
  ];

  if (!findings.length) {
    lines.push(`No issues found.`);
    return lines.join("\n");
  }

  for (const slide of [...bySlide.keys()].sort((a, b) => a - b)) {
    const items = bySlide.get(slide)!.sort(bySeverity);
    lines.push(`## Slide ${slide}`, ``);
    for (const f of items) {
      lines.push(`- ${ICON[f.severity]} **${f.title}** \`${f.category}\``);
      lines.push(`  - ${f.detail}`);
      if (f.quote) lines.push(`  - Found: \`${f.quote.replace(/`/g, "'")}\``);
      if (f.suggestion) lines.push(`  - Fix: \`${f.suggestion.replace(/`/g, "'")}\``);
      if (f.relatedSlides?.length) lines.push(`  - Also on slides: ${f.relatedSlides.join(", ")}`);
    }
    lines.push(``);
  }
  return lines.join("\n");
}

const ORDER: Record<Severity, number> = { error: 0, warn: 1, info: 2 };
export const bySeverity = (a: Finding, b: Finding) => ORDER[a.severity] - ORDER[b.severity];

export function tally(findings: Finding[]) {
  return {
    error: findings.filter((f) => f.severity === "error").length,
    warn: findings.filter((f) => f.severity === "warn").length,
    info: findings.filter((f) => f.severity === "info").length,
  };
}

export function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
