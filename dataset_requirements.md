# Dataset Format & Specifications for Training

## 1. Quick Summary (Copy-Pasteable Answer)

- **File Extension**: `.jsonl` (JSON Lines format)
- **Data Types**:
  1. **SFT Dataset (`sft-train.jsonl`)**: Standard 3-role Chat format (`system`, `user`, `assistant`).
  2. **DPO Dataset (`dpo-train.jsonl`)**: Preference pair format (`input`, `preferred_output`, `non_preferred_output`).
  3. **Benchmark Dataset (`benchmark.jsonl`)**: Evaluation split for testing model accuracy before deployment.
  4. **Feedback Ledger (`feedback-ledger.jsonl`)**: Provider-neutral archive of every saved feedback event, its sanitized input when available, feedback/correction, review status, and model provenance.
- **Content**: Plain text slide content + structured JSON correction outputs. Sensitive PPTX files and image pixels are excluded. The ledger is evidence for later transforms; only approved rows become SFT/DPO training data.

---

## 2. Technical File Formats & Schemas

### A. Supervised Fine-Tuning (SFT) Format (`sft-train.jsonl`)

```json
{
  "messages": [
    { "role": "system", "content": "You are a slide analysis expert..." },
    {
      "role": "user",
      "content": "Proofread this deck. 1 slides.\n\n--- SLIDE 1 ---\n[Extracted Slide Text]"
    },
    {
      "role": "assistant",
      "content": "{\"findings\":[{\"slide\":1,\"severity\":\"warn\",\"category\":\"clarity\",\"quote\":\"Original text\",\"suggestion\":\"Corrected text from human reviewer\",\"detail\":\"...\"}]}"
    }
  ],
  "metadata": {
    "id": "feedback-123",
    "deck_fingerprint": "abc123hash",
    "rating": "useful"
  }
}
```

### B. Direct Preference Optimization (DPO) Format (`dpo-train.jsonl`)

```json
{
  "input": {
    "messages": [
      { "role": "system", "content": "You are a slide analysis expert..." },
      {
        "role": "user",
        "content": "Proofread this deck. 1 slides.\n\n--- SLIDE 1 ---\n[Extracted Slide Text]"
      }
    ]
  },
  "preferred_output": [
    {
      "role": "assistant",
      "content": "{\"findings\":[<Human-Corrected Finding JSON>]}"
    }
  ],
  "non_preferred_output": [
    {
      "role": "assistant",
      "content": "{\"findings\":[<Original Incorrect AI Finding JSON>]}"
    }
  ],
  "metadata": { "id": "feedback-123", "deck_fingerprint": "abc123hash" }
}
```

---

## 3. Dataset Requirements & Volume Targets

- **Eligibility**: Feedback must be approved by an admin. DPO requires an explicit text correction.
- **Volume Targets**:
  - **First Run**: 300–500 approved examples (Minimum floor: 50).
  - **Production Prototype**: 500–1,000 preference pairs (Minimum floor: 20).
  - **Evaluation Baseline**: 100–200 held-out examples (deck-disjoint split).
