/**
 * PowerPoint writes style variants into the typeface name — "Open Sans Light",
 * "Montserrat SemiBold". CSS wants family + weight. Split them apart.
 */
const WEIGHT_SUFFIX: [RegExp, number][] = [
  [/\s+(thin|hairline)$/i, 100],
  [/\s+extra\s*light$/i, 200],
  [/\s+light$/i, 300],
  [/\s+regular$/i, 400],
  [/\s+medium$/i, 500],
  [/\s+(semi\s*bold|demi\s*bold)$/i, 600],
  [/\s+bold$/i, 700],
  [/\s+extra\s*bold$/i, 800],
  [/\s+(black|heavy)$/i, 900],
];

export interface FontSpec {
  family: string;
  weight: number;
}

export function normalizeFont(typeface: string): FontSpec {
  for (const [re, weight] of WEIGHT_SUFFIX) {
    if (re.test(typeface)) return { family: typeface.replace(re, "").trim(), weight };
  }
  return { family: typeface.trim(), weight: 400 };
}

/** Every distinct family used by text runs in the deck. */
export function collectFamilies(fonts: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const f of fonts) {
    const fam = normalizeFont(f).family;
    if (fam) out.add(fam);
  }
  return [...out];
}

/**
 * One stylesheet URL for all families. Google-exported decks overwhelmingly use
 * Google Fonts, so this recovers the real faces; anything it doesn't serve
 * falls back to the system stack silently (display=swap, no error).
 */
export function googleFontsUrl(families: string[]): string | null {
  const wanted = families.filter((f) => !SYSTEM_FONTS.has(f.toLowerCase()));
  if (!wanted.length) return null;
  const parts = wanted
    .slice(0, 8) // a deck with more distinct webfonts than this has bigger problems
    .map((f) => `family=${encodeURIComponent(f).replace(/%20/g, "+")}:wght@300;400;500;600;700`);
  return `https://fonts.googleapis.com/css2?${parts.join("&")}&display=swap`;
}

/** Faces that ship with Windows/macOS — requesting these from Google is pointless. */
const SYSTEM_FONTS = new Set(
  ["arial", "calibri", "cambria", "candara", "comic sans ms", "consolas", "courier new", "georgia", "helvetica", "impact", "segoe ui", "tahoma", "times new roman", "trebuchet ms", "verdana"],
);
