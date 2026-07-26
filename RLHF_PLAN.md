# Proposal Checker: Feedback Learning and Managed RLHF

## 1. Goal

Build a proposal checker that learns from reviewed user feedback.

The system has two learning levels:

1. **Immediate adaptation** — feedback affects the next analysis through stored feedback memory.
2. **Model improvement** — approved feedback is periodically sent to a managed reinforcement fine-tuning service.

No local GPU, VPS, or manually hosted model is required.

## 2. Simple architecture

```text
User reviews AI finding
        |
        v
Vercel app/API
        |
        +--> Neon: feedback and training data
        |
        +--> AI provider: analysis requests

Approved feedback
        |
        v
Managed training API
        |
        v
New hosted model version
```

Vercel remains responsible for the web app and API routes. The AI provider runs the training and hosts the trained model.

## 3. How the user experience works

1. AI analyzes a proposal.
2. User marks a finding as useful or not useful.
3. User can correct the finding or choose a preferred answer.
4. Feedback is saved in Neon.
5. The next analysis immediately uses approved feedback as context.
6. An admin periodically reviews feedback and starts a training job.
7. The provider trains a new model version.
8. The new model is evaluated before it becomes active.

The model should not retrain after every click. Periodic training prevents one incorrect rating from damaging the model.

## 4. Required feedback data

Each approved training example should contain:

- Sanitized slide/proposal input
- Original AI finding
- Corrected finding, if available
- Preferred answer
- Rejected answer, if available
- Human rating and reason
- Provider and model version
- Prompt version
- Reviewer and timestamp

Binary `Useful / Not useful` feedback alone is not enough for reliable training.

Keep confidential PPTX files and images in private object storage. Neon should store metadata and secure references, not raw client documents.

## 5. Training options

### Recommended: managed provider training

Use a provider API such as OpenAI's managed fine-tuning service. OpenAI supports supervised, DPO, and reinforcement fine-tuning methods; reinforcement training requires a grader. [OpenAI fine-tuning API](https://platform.openai.com/docs/api-reference/fine-tuning/resume?lang=python)

Requirements:

- Provider API key
- Eligible base model
- Approved JSONL dataset
- Reward/grader definition
- Provider billing
- Returned model ID

No local GPU or VPS is needed.

### Gemini limitation

Gemini Developer API currently has no available model for direct API fine-tuning. [Google Gemini tuning documentation](https://ai.google.dev/gemini-api/docs/model-tuning/)

Gemini can still be used for image and slide understanding while another managed model handles trained finding generation.

## 6. Grader/reward design

The reward should combine human feedback with objective checks:

```text
reward =
  human preference
  + valid JSON/schema
  + valid slide reference
  + source quote exists
  + correct severity/category
  - hallucination penalty
```

This prevents the model from learning only to satisfy positive ratings while producing invalid or ungrounded findings.

## 7. Implementation phases

### Phase 1 — Feedback foundation

- Add correction and preferred-answer fields to the feedback UI.
- Add reviewer authentication and an admin review queue.
- Store model and prompt versions.
- Add export to a training-ready JSONL format.

### Phase 2 — Immediate adaptation

- Keep the existing Neon feedback-memory system.
- Apply approved feedback to future prompts.
- Add audit logs and confidence thresholds.

### Phase 3 — Evaluation baseline

- Build an expert-reviewed benchmark.
- Measure false positives, missed issues, grounding, severity, and JSON validity.
- Save the current Gemini result as the baseline.

### Phase 4 — Managed training prototype

- Start with supervised fine-tuning or DPO.
- Validate the new model against the benchmark.
- Add reinforcement fine-tuning when the grader is reliable.

### Phase 5 — Promotion and rollback

- Store candidate and active model IDs.
- Compare the new model against Gemini.
- Promote only when evaluation improves.
- Keep one-click rollback.

## 8. Data targets

Suggested starting targets:

- 300–500 reviewed examples for a first experiment
- 500–1,000 preference pairs for a useful prototype
- 100–200 held-out examples for evaluation

Split data by deck or client to avoid training and testing on nearly identical slides.

## 9. Deployment configuration

Vercel stores these as server-side environment variables:

```text
AI_PROVIDER
AI_API_KEY
AI_MODEL
TRAINING_PROVIDER
TRAINING_MODEL
DATABASE_URL
```

Never expose the API key in browser code.

## 10. Acceptance criteria

The feature is ready when:

- Reviewed feedback changes the next analysis immediately.
- Only approved feedback can enter a training dataset.
- A managed training job can be started without local GPU infrastructure.
- Every model version has evaluation results.
- A failed or worse model can be rejected or rolled back.
- API keys and client documents remain private.
- The app continues working if training is unavailable.

## Recommended first implementation

Keep Gemini for visual slide analysis, keep Neon for immediate feedback memory, and add a managed OpenAI training pipeline for structured finding generation. Start with supervised/DPO training, then enable reinforcement fine-tuning after enough high-quality reviewed feedback exists.
