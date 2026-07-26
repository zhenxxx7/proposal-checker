# Rollout Plan: Feedback Learning & Managed RLHF

> Implementation status: **all Phase A–C code is finished and verified**
> (see RLHF_PLAN.md for the technical design). This document is the
> operational guide: what is usable today, when money starts being spent,
> and which commands to run at each stage.

## Status summary

| Capability | Status | Requires |
|---|---|---|
| AI analysis + Useful/Not useful ratings | ✅ ready | already running (Gemini + Neon) |
| Per-finding corrections & reasons ("Add details") | ✅ ready | — |
| Shared memory across devices | ✅ ready | `DATABASE_URL` (already set) |
| Admin review queue at `/admin` | ✅ ready | set `ADMIN_TOKEN` |
| Analysis-input capture for training | ✅ ready, off by default | set `TRAINING_CAPTURE=true` |
| Dataset export & builder (SFT/DPO) | ✅ ready | approved data |
| Evaluation harness + Gemini baseline | ✅ stored (composite 0.985) | — |
| Managed fine-tuning (SFT/DPO) | ✅ code ready, not yet run | ~300–500 approved corrections + a paid provider |
| RFT (true RL with a grader), image-byte capture, rating retraction | ⏳ deferred (M6) | after DPO proves out |

---

## Phase A — Use it today (free)

### 1. Production setup (once, in Vercel → Settings → Environment Variables)

```text
ADMIN_TOKEN=<32+ random bytes>     # unlocks /admin; generate with:
                                   # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
TRAINING_CAPTURE=true              # store analysis inputs so feedback can become training pairs
FEEDBACK_TOKEN_SECRET=<32+ bytes>  # optional; extra bar for public deployments
```

Privacy note: `TRAINING_CAPTURE=true` stores the slide text sent to the
model (not the PPTX file, not image pixels) in Neon, with a 90-day
retention unless pinned by an approval. If a client asks for their data to
be deleted: `npm run retention -- --purge-deck deck-v1-<hex>`.

Do **not** enable `FEEDBACK_REQUIRE_APPROVAL` yet — turn it on after the
first review backlog is cleared, so the learned memory does not suddenly
go silent.

### 2. Daily flow (users)

1. Upload a deck / Google Slides link → analysis runs automatically.
2. Rate AI findings: **Useful / Not useful**.
3. For wrong findings, click **Add details** and enter the *correction* —
   a rating without a correction still suppresses repeats, but **only a
   correction can become training data**.

### 3. Weekly flow (admin — you)

1. Open `/admin`, sign in with `ADMIN_TOKEN`.
2. Review the pending queue: **Approve** what is right, **Reject** what is
   wrong, and fill in corrections via the text field when the reviewer
   left them empty (rows tagged *"needs a correction to be trainable"*).
3. Once the first backlog is cleared → set `FEEDBACK_REQUIRE_APPROVAL=true`
   so only approved feedback steers analysis.

---

## Phase B — Collect data (free, runs by itself)

Targets before the first training run (from RLHF_PLAN.md §8):

- **300–500** reviewed (approved) examples for the first experiment;
- **500–1,000** preference pairs (corrections) for a useful prototype;
- data should come from **diverse decks** — the builder automatically
  keeps the train/eval split deck-disjoint.

How to monitor: the per-tab counts in `/admin` (pending/approved/rejected),
or run `npm run dataset` at any time — `stats.json` prints how many
examples qualify and why each skipped row was skipped. The builder warns
while the counts stay below the minimum floors.

---

## Phase C — First training run (paid — your decision)

**Decision to make first:** the training provider.

| Provider | Methods | Estimated cost | Notes |
|---|---|---|---|
| OpenAI (adapter already built) | SFT + DPO + RFT | ~$5–20 per SFT/DPO run; RFT far more | the only path all the way to true RLHF |
| Together AI (adapter not written yet) | SFT + DPO | generally cheaper | stops at DPO |

Verify the provider's live pricing and API shapes against their docs
before the first real run. Nothing is billed until `TRAINING_API_KEY` is
set and `start` is invoked.

Steps (all from the terminal, no GPU/VPS anywhere):

```bash
npm run dataset
```

```bash
npm run train -- upload --file training-data/dpo-train.jsonl
```

```bash
npm run train -- start --method dpo --training-file file-XXXX --validation-file file-YYYY
```

```bash
npm run train -- status
```

When the job succeeds, `status` records the `ft:...` model as a
**candidate** in the registry and prints its evaluation command. Then:

```bash
npm run eval -- --base-url https://api.openai.com/v1 --model ft:XXXX --api-key-env TRAINING_API_KEY --save model-v1-dpo-XXXX
```

```bash
npm run train -- promote --id model-v1-dpo-XXXX
```

`promote` **refuses** a candidate that does not beat the Gemini baseline
(composite ≥ baseline, F1 +2 points, JSON validity ≥ 98%, no grounding or
clean-deck regression). After promotion the text pass serves from the
fine-tuned model; the image pass stays on Gemini. If production results
disappoint:

```bash
npm run train -- rollback --task text
```

---

## Phase D — Later (deferred; do not build now)

- **RFT** (reinforcement fine-tuning with a grader): enable only after DPO
  proves out and the grader scores (`lib/ai/evalScorers.ts`,
  `GRADER_WEIGHTS`) demonstrably correlate with reviewer approvals.
- Image-byte capture (private Vercel Blob) for vision training.
- Rating retraction; a model-registry UI inside `/admin`.

---

## Quick reference

Verification (keyless dev loop — see the README):

```bash
npm run verify:feedback
```

```bash
npm run verify:ui -- scripts/__fixture-deck.pptx
```

```bash
npm run verify:admin -- <adminToken>
```

All feature env vars (every one optional; unset = feature off):
`ADMIN_TOKEN`, `FEEDBACK_REQUIRE_APPROVAL`, `FEEDBACK_TOKEN_SECRET`,
`TRAINING_CAPTURE`, `TRAINING_CAPTURE_TTL_DAYS`, `TRAINING_PROVIDER`,
`TRAINING_API_KEY`, `TRAINING_BASE_URL`, `TRAINING_MODEL`,
`MODEL_REGISTRY_ENABLED`, `FEEDBACK_PROMPT_MEMORY_TTL_MS`,
`AI_TEXT_*` / `AI_IMAGE_*`. Details in `.env.example`.
