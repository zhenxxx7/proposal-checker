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

**2. AI deep check — opt-in, costs tokens.**
Sends slide text and downscaled copies of the mockup images to Claude Opus 4.8.
Reads the text rendered inside each image and proofreads the whole deck in context.

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

## Usage

```bash
npm install
npm run dev            # http://localhost:3000
```

Rule checks need no configuration. For the AI pass:

```bash
cp .env.example .env.local   # add your ANTHROPIC_API_KEY
```

### Headless CLI

Same rule engine, no browser and no API key — useful in CI:

```bash
npm run check -- "proposal.pptx"
npm run check -- "proposal.pptx" --md report.md
npm run check -- "a.pptx" "b.pptx" --debug     # --debug prints every finding
```

---

## Deploying

Deploys to Vercel as-is. Set `ANTHROPIC_API_KEY` as an environment variable —
it is read server-side only and never reaches the browser.

The deck itself is never uploaded. Only the AI pass sends data, and only:

- the extracted slide text, in one request;
- each qualifying image, re-encoded to JPEG at ≤2200px on the long edge, one per
  request (well under Vercel's 4.5MB body limit).

Both API routes set `maxDuration = 300`.

---

## Notes and limits

- **Parsing is main-thread.** `DOMParser` does not exist in a Web Worker, so a
  143MB deck blocks the UI for roughly a second. Measured: 757ms parse, 13ms checks.
- **The slide preview is a reconstruction, not a renderer.** Shapes are positioned
  from the OOXML geometry so a finding can point at the offending element. Fills,
  effects, theme fonts, and text autofit are not reproduced.
- **Image selection for the AI pass**: pictures at least 300px wide whose on-slide
  area is ≥2% of the slide. A 56-slide deck with 318 pictures yields ~30 images.
- Charts, SmartArt, and tables contribute their text but not their geometry.
