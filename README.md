# Proposal Checker

Drop a `.pptx` proposal in. Get back a slide-by-slide list of typos, blurry images,
distorted images, and sizing that is *almost* consistent but not quite — including
typos rendered **inside** mockup screenshots, where no spell-checker ever looks.

Built for checking client proposals before they are submitted.

---

## Two passes

**1. Rule checks — instant, free, offline.**
The `.pptx` is unzipped and parsed *in your browser*. Nothing is uploaded. Runs in
under a second on a 143MB, 56-slide deck.

**2. AI deep check — opt-in, free providers.**
Sends slide text and downscaled copies of the mockup images to any
OpenAI-compatible endpoint. Reads the text rendered inside each image and
proofreads the whole deck in context.

The rule pass is the default. The AI pass is a button.

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
| Effective resolution 96–150 DPI — soft when printed or projected | review |
| Aspect distorted >5% (stretched/squashed) | blocking |
| Aspect distorted 2–5% | review |
| Side-by-side images with near-identical size that don't match (off by 1–8%) | review |
| Images almost aligned on a shared edge (1–4px out) | review |
| Same image nudged to slightly different sizes across slides | review |
| Text box runs past the slide edge | review |
| Element parked entirely off-canvas (aggregated across slides) | minor |
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
Typos, grammar, clipped or truncated labels, placeholder UI copy (`Lorem ipsum`,
`Your text here`), and terminology that contradicts the surrounding slide text.

---

## Signal, not noise

The pairwise sizing checks only compare **layout siblings**: pictures that each
occupy ≥3% of the slide *and* share a row or column. Without that gate, a slide with
a 120-logo wall generates thousands of meaningless "these two are almost the same
size" findings. On a real 56-slide deck the gate takes the output from 2,951
findings down to 53.

Repeated template artefacts (an off-canvas footer on 32 slides) collapse into a
single finding that lists the slides.

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
suggestion has a one-click **copy**. Light and dark themes, remembered. The AI button
disables itself with a reason when no provider is configured, instead of failing on click.

An AI run on an image-heavy deck is 60–100 requests, so it is **cancellable** — stopping
keeps every finding collected up to that point.

---

## Usage

```bash
npm install
npm run dev            # http://localhost:3000
```

Rule checks need no configuration. For the AI pass, copy `.env.example` to
`.env.local` and pick a provider:

| `AI_PROVIDER` | Cost | Deployable | Privacy |
|---|---|---|---|
| `gemini` *(default)* | free tier | yes | free-tier data may be used for training |
| `ollama` | free, local | no | deck never leaves the machine |
| `openrouter` | free `:free` models | yes | depends on the model |
| `custom` | — | — | set `AI_BASE_URL` to any OpenAI-compatible `/v1` |

```bash
cp .env.example .env.local
# AI_PROVIDER=gemini
# AI_API_KEY=...            # https://aistudio.google.com/apikey
```

**If the deck is under NDA, use `ollama`.** Gemini's free tier permits Google to
train on submitted data, and mockups are exactly the thing you would not want
leaving the building.

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
AI_PROVIDER=custom AI_BASE_URL=http://localhost:11435/v1 AI_MODEL=mock npm run dev

# terminal 3
npm run verify:ai
npm run verify:ui -- "proposal.pptx"   # drives the AI button too
```

---

## Deploying

Deploys to Vercel as-is. Set `AI_PROVIDER` and `AI_API_KEY` as environment
variables — they are read server-side only and never reach the browser.
(`ollama` is the exception: it targets `localhost` and cannot run on Vercel.)

The deck itself is never uploaded. Only the AI pass sends data, and only:

- the extracted slide text, in one request;
- each qualifying image, re-encoded to JPEG at ≤1400px on the long edge, one per
  request (well under Vercel's 4.5MB body limit).

Images are deduplicated by file + crop before being sent: a logo reused on 30
slides is one request, and a typo found inside it is reported on all 30.

Both API routes set `maxDuration = 300`.

---

## Notes and limits

- **Parsing is main-thread.** `DOMParser` does not exist in a Web Worker, so a
  143MB deck blocks the UI for roughly a second. Measured: 757ms parse, 13ms checks.
- **The slide preview is a reconstruction, not a renderer.** Shapes are positioned
  from the OOXML geometry, and it does render the slide background, shape fills,
  borders, and text colour/alignment (resolving theme colours from `theme1.xml`
  plus alpha/lumMod/lumOff/shade/tint modifiers) so it reads like the real deck.
  What it does *not* reproduce: theme fonts (everything is Geist), shadows and
  other effects, WordArt, and text autofit. Backgrounds inherited from a slide
  layout or master rather than set on the slide itself fall back to white — in
  the NLB deck that is 5 of 56 slides.
- **Image selection for the AI pass**: pictures at least 300px wide whose on-slide
  area is ≥2% of the slide, deduplicated by file + crop. Two requests run in
  flight at a time — free tiers cap requests per minute.
- Charts, SmartArt, and tables contribute their text but not their geometry.
