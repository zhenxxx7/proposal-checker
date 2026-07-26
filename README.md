# Proposal Checker

Drop a `.pptx` proposal in or paste a public Google Slides share link. Get back a
slide-by-slide list of typos, blurry images,
distorted images, and sizing that is *almost* consistent but not quite — including
typos rendered **inside** mockup screenshots, where no spell-checker ever looks.

Built for checking client proposals before they are submitted.

---

## One combined analysis

The `.pptx` is unzipped and parsed *in your browser*. After parsing, local rule
checks and AI text/image checks start together. Results stay behind one progress
screen until every branch settles, then appear once as one merged result set.
One upload, one wait, no second analysis click.

When no AI provider is configured, the same flow finishes with local rules only.
Local `.pptx` files never leave the browser; AI receives only extracted text and
downscaled copies of qualifying mockup images.

---

## What it catches

### Text
| Check | Severity |
|---|---|
| Repeated word (`the the`) | blocking |
| Placeholder left in deck (`lorem ipsum`, `TBD`, `XXX`, `[insert]`) | blocking |
| Double spaces, space before punctuation, missing space after a comma | review |
| Doubled punctuation (`!!`, `..`), unbalanced brackets/quotes | review |
| **Same term written two ways** (`Back End` / `Backend`, `Touch Screen` / `touchscreen`) | review |
| **Capitalisation drift** (`HarbourFront` / `Harbourfront`, `FXMedia` / `FXMEDIA`) | review |
| Mixed straight and curly quotes; title font size varies | minor |

Capitalisation drift is filtered so that `DESIGN` vs `Design` — a heading-style
choice — is aggregated into one minor note, while `HarbourFront` vs `Harbourfront`
is reported as a real mistake. The difference: only the second has an
internally-capitalised form.

### Images
| Check | Severity |
|---|---|
| Effective resolution below 96 DPI — image is upscaled, will look blurry | blocking |
| Aspect distorted >5% (stretched/squashed) | blocking |
| Aspect distorted 2–5% | review |
| Side-by-side images with near-identical size that don't match (off by 1–8%) | review |
| Images almost aligned on a shared edge (1–4px out) | review |
| Same image nudged to slightly different sizes across slides | review |
| Text box runs past the slide edge | review |
| Large asset rendered tiny — file bloat or stray element | minor |

### Slides
| Check | Severity |
|---|---|
| Near-duplicate slides — same content images **and** most of the same text | review |

A repeated footer or logo is not enough to flag a slide: duplicate detection
requires the *content* pictures (≥2% of the slide, keyed by file + crop) to
match as well as the body text (Jaccard ≥ 0.7 on images, ≥ 0.5 on text). Three
or more identical slides collapse into one finding via union-find.

Effective DPI accounts for PowerPoint's crop rectangle (`a:srcRect`) and 90°
rotation, so a 40px logo cropped out of a 2000px sprite sheet is measured as 40px,
not 2000px.

### Inside images (AI pass)
Confidently legible typos, grammar, placeholder UI copy (`Lorem ipsum`, `Your
text here`), and clearly visible clipping. It ignores outside explanatory text
that differs from mockup labels, tiny scenery text, and low-resolution OCR
artefacts.

---

## Signal, not noise

The pairwise sizing checks only compare **layout siblings**: pictures that each
occupy ≥3% of the slide *and* share a row or column. Without that gate, a slide with
a 120-logo wall generates thousands of meaningless "these two are almost the same
size" findings. On a real 56-slide deck the gate takes the output from 2,951
findings down to 53.

Elements entirely outside the slide canvas are ignored because they never appear
in the exported presentation.

---

## The interface

**Summary** is the landing view. A verdict banner (*Not ready to send* / *Almost ready* /
*Ready to send*), three counters, then findings **grouped by what you'd actually do about
them** — "6 images will look blurry (slide 79, 82, 83, 85, 86)" rather than six separate
rows. Blocking groups start expanded. Click any finding to jump to its slide.

**Slides** is the drill-down. A lazy-rendered thumbnail rail (only ~7 of 93 previews mount
at a time), the reconstructed slide, and the findings on it. Clicking a finding outlines
the exact shape. `←` / `→` walk the deck.

Search filters the list; it never changes the verdict or the counters. Every fix
suggestion has a one-click **copy**. Light and dark themes, remembered. When a provider
is configured, local rules plus AI text and vision checks run as one automatic analysis;
the button only re-runs AI, and disables itself with a reason when no provider is set.
AI findings also carry a **Useful / Not useful** dropdown. The latest choice is
saved in that browser and appears consistently in Summary and Slides; rule
findings have no feedback control. On the next AI run, findings that match the
latest normalized pattern marked **Not useful** are hidden for the same deck.
Cross-deck suppression is deliberately conservative: at least two distinct
decks must agree and at least 80% of their latest ratings must be **Not useful**.
A visible notice shows how many were skipped and can reset all locally learned
choices without another AI request.

An AI run on an image-heavy deck is 60–100 requests, so it is **cancellable** — stopping
keeps every finding collected up to that point.

---

## Usage

```bash
npm install
npm run dev            # http://localhost:3000
```

Use either a local `.pptx` file or a standard Google Slides share link. Google
Slides imports must be viewable by anyone with the link and allow downloads. A
serverless Node handler downloads and parses Google's PowerPoint export, removes
unused media, and downscales large preview images. It streams live download and
preparation progress back to the page; the browser receives processed slide data,
never the raw `.pptx` file.

Rule checks need no configuration. For the AI pass, copy `.env.example` to
`.env.local` and pick a provider:

Only hosted (non-local) providers are supported, so the app deploys to Vercel
serverless as-is:

| `AI_PROVIDER` | Cost | Privacy |
|---|---|---|
| `gemini` *(default)* | free tier | free-tier data may be used for training |
| `openrouter` | free `:free` models | depends on the model |
| `custom` | — | set `AI_BASE_URL` to any remote OpenAI-compatible `/v1` |

```bash
cp .env.example .env.local
# AI_PROVIDER=gemini
# AI_API_KEY=...            # https://aistudio.google.com/apikey
```

Without a database, feedback learning is deterministic application-level
learning: it stays in that browser, is removed when browser storage is cleared,
and never changes Gemini model weights. When `DATABASE_URL` is supplied by a
Vercel-managed Neon project, each explicit **Useful / Not useful** choice is
also saved as shared memory. On the next run it is used twice: server retrieves
a short set of matching reviewer-rated patterns and adds them to Gemini's system
instruction, then app applies same policy before results show. Same-deck choices
apply on next run; cross-deck prompt guidance needs two decks and 80% agreement.
App still falls back to browser-local learning if Neon is unavailable.

Shared memory stores the rated AI finding (quote, suggested correction, and
metadata), its content fingerprint, and model name. It does **not** store the
uploaded `.pptx`, slide preview images, or raw image data. Gemini receives only
small retrieved calibration examples relevant to current text/image pass, never
whole feedback database. This is retrieval-augmented, RLHF-like feedback
learning, not continuous RLHF or Gemini weight training.
Use it only in the private development workspace for now; add sign-in and rate
limiting before enabling shared feedback on a public deployment.

**If the deck is confidential, skip the AI pass.** The rule checks run entirely
in the browser and upload nothing; only the AI pass sends data out, and Gemini's
free tier permits Google to train on it.

All four speak the same OpenAI chat-completions shape, so the whole AI layer is
one `fetch` and a base URL — switching provider is one env var. The client
negotiates `response_format` once (`json_schema` → `json_object` → prompt-only),
caches what worked, strips markdown fences, retries `429`s with backoff, and
discards findings that do not match the schema.

### Headless CLI

Same rule engine, no browser and no API key — useful in CI:

```bash
npm run check -- "proposal.pptx"
npm run check -- "proposal.pptx" --md report.md
npm run check -- "a.pptx" "b.pptx" --debug     # --debug prints every finding
```

It prints the verdict and the grouped fix list, the same shape as the Summary view.

### UI verification

Drives the real interface in a real Chrome against a real deck — upload, grouping,
navigation, search, highlighting, console errors. Needs the dev server running.

```bash
npm run dev
npm run verify:ui -- "proposal.pptx"
npm run verify:google -- "https://docs.google.com/presentation/d/.../edit"
npm run verify:server-import -- "proposal.pptx"
```

Uses `puppeteer-core` against an already-installed Chrome or Edge; it does not download
a browser. Writes `scripts/__summary.png`, `__slides.png`, `__search.png` (gitignored).

### AI verification without a key

`scripts/mock-ai.mjs` is a deliberately hostile OpenAI-compatible endpoint: it
rejects `json_schema`, rate-limits the first image, wraps replies in markdown
fences, and returns a finding with an invalid severity. It proves the AI layer's
fallbacks without spending a quota.

```bash
# terminal 1
npm run mock:ai

# terminal 2
AI_PROVIDER=custom AI_BASE_URL=http://localhost:11435/v1 AI_MODEL=mock AI_API_KEY=mock npm run dev

# terminal 3
npm run verify:ai
npm run verify:ui -- "proposal.pptx"   # drives the AI button too
```

---

## Deploying

Deploys to Vercel as-is. Set `AI_PROVIDER` and `AI_API_KEY` as environment
variables — they are read server-side only and never reach the browser. All
supported providers are hosted, so nothing depends on a machine-local endpoint.

Local `.pptx` files are never uploaded. For a Google Slides link, one serverless
request downloads and parses the raw export in memory; no file, database record,
or durable server state is created. The browser receives only structured slide
data and referenced, size-reduced preview assets. With no `DATABASE_URL`, AI
feedback and learned suppression stay in browser `localStorage`. With Neon,
only rated finding metadata becomes durable shared memory; a bounded matching
subset is added server-side to next Gemini prompt. Deck files and image previews
remain ephemeral.
The AI pass sends only:

- the extracted slide text, in one request;
- each qualifying image, re-encoded to JPEG at ≤1400px on the long edge, one per
  request (well under Vercel's 4.5MB body limit).

Images are deduplicated by file + crop before being sent: a logo reused on 30
slides is one request, and a typo found inside it is reported on all 30.

The analysis and Google Slides import routes set `maxDuration = 300`.

---

## Versioning

The version badge in the bottom-right corner of the app is derived from git
history at build time (see `next.config.ts`) — no version number is ever edited
by hand. Commit subjects follow [Conventional Commits](https://www.conventionalcommits.org):

| Commit subject | Bump |
|---|---|
| `feat: ...` | minor |
| `feat!: ...` or a `BREAKING CHANGE` note in the body | major |
| anything else (`fix:`, `docs:`, plain text, ...) | patch |

Shallow clones (Vercel builds) fall back to the commit SHA as the patch
segment; without git, the badge shows the `package.json` version.

---

## Notes and limits

- **Local-file parsing is main-thread.** `DOMParser` does not exist in a Web
  Worker, so a 143MB local deck blocks the UI for roughly a second. Measured:
  757ms parse, 13ms checks. Google Slides exports are parsed in the serverless
  import handler instead.
- **The slide preview reconstructs the complete visual stack.** It renders the
  slide background plus visual shapes inherited from the layout and master, so
  branded panels, footer bars, and master logos stay visible. Theme colours,
  fills, borders, text styling, and geometry are resolved from OOXML.
  It remains a browser reconstruction rather than an Office renderer: shadows,
  advanced effects, WordArt, tables, charts, and text autofit may still differ.
- **Image selection for the AI pass**: pictures at least 300px wide whose on-slide
  area is ≥2% of the slide, deduplicated by file + crop. Two requests run in
  flight at a time — free tiers cap requests per minute.
- Charts, SmartArt, and tables contribute their text but not their geometry.
