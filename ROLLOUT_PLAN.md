# Rencana Pemakaian: Feedback Learning & Managed RLHF

> Status implementasi: **semua kode Fase A–C sudah selesai dan terverifikasi**
> (lihat RLHF_PLAN.md untuk desain teknisnya). Dokumen ini adalah panduan
> operasional: apa yang bisa dipakai hari ini, kapan mengeluarkan uang, dan
> perintah apa yang dijalankan di tiap tahap.

## Ringkasan status

| Kemampuan | Status | Butuh apa |
|---|---|---|
| Analisis AI + rating Useful/Not useful | ✅ siap pakai | sudah jalan (Gemini + Neon) |
| Koreksi & alasan per temuan ("Add details") | ✅ siap pakai | — |
| Memory bersama lintas perangkat | ✅ siap pakai | `DATABASE_URL` (sudah ada) |
| Antrean review admin `/admin` | ✅ siap pakai | set `ADMIN_TOKEN` |
| Capture input untuk training | ✅ siap, default mati | set `TRAINING_CAPTURE=true` |
| Export & builder dataset (SFT/DPO) | ✅ siap | data approved |
| Evaluasi + baseline Gemini | ✅ tersimpan (composite 0.985) | — |
| Fine-tuning terkelola (SFT/DPO) | ✅ kode siap, belum dijalankan | ~300–500 koreksi approved + provider berbayar |
| RFT (true RL dengan grader), capture byte gambar, tombol retract | ⏳ ditunda (M6) | setelah DPO terbukti |

---

## Fase A — Pakai hari ini (gratis)

### 1. Setup produksi (sekali saja, di Vercel → Settings → Environment Variables)

```text
ADMIN_TOKEN=<32+ byte acak>        # buka /admin; generate:
                                   # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
TRAINING_CAPTURE=true              # simpan input analisis agar feedback bisa jadi training pair
FEEDBACK_TOKEN_SECRET=<32+ byte>   # opsional; bar ekstra untuk deployment publik
```

Catatan privasi: `TRAINING_CAPTURE=true` menyimpan teks slide yang dikirim ke
model (bukan file PPTX, bukan pixel gambar) di Neon, dengan retensi 90 hari
kecuali di-pin oleh approval. Kalau ada klien yang minta datanya dihapus:
`npm run retention -- --purge-deck deck-v1-<hex>`.

`FEEDBACK_REQUIRE_APPROVAL` **jangan diaktifkan dulu** — nyalakan nanti
setelah backlog review pertama selesai, supaya learned memory tidak mendadak
kosong.

### 2. Alur harian (pengguna)

1. Upload deck / tautan Google Slides → analisis jalan otomatis.
2. Nilai temuan AI: **Useful / Not useful**.
3. Untuk temuan yang salah, klik **Add details** dan isi *koreksinya* —
   rating tanpa koreksi tetap menekan temuan berulang, tapi **hanya koreksi
   yang bisa menjadi data training**.

### 3. Alur mingguan (admin — Anda)

1. Buka `/admin`, login dengan `ADMIN_TOKEN`.
2. Review antrean pending: **Approve** yang benar, **Reject** yang salah,
   lengkapi koreksi lewat kolom teks bila reviewer tidak mengisinya
   (baris ber-tag *"needs a correction to be trainable"*).
3. Setelah backlog pertama beres → set `FEEDBACK_REQUIRE_APPROVAL=true`
   agar hanya feedback approved yang menyetir analisis.

---

## Fase B — Kumpulkan data (gratis, berjalan sendiri)

Target sebelum training pertama (dari RLHF_PLAN.md §8):

- **300–500** contoh reviewed (approved) untuk eksperimen pertama;
- **500–1.000** pasangan preferensi (koreksi) untuk prototipe yang berguna;
- data harus datang dari **deck yang beragam** — split train/eval dipisah
  per-deck otomatis oleh builder.

Cara memantau: angka per-tab di `/admin` (pending/approved/rejected), atau
jalankan `npm run dataset` kapan saja — `stats.json` mencetak jumlah contoh
yang layak dan alasan setiap yang di-skip. Builder memberi peringatan selama
masih di bawah ambang minimum.

---

## Fase C — Training pertama (mulai berbayar — keputusan Anda)

**Keputusan yang harus diambil dulu:** provider training.

| Provider | Metode | Perkiraan biaya | Catatan |
|---|---|---|---|
| OpenAI (adapter sudah ada) | SFT + DPO + RFT | ~$5–20 per run SFT/DPO; RFT jauh lebih mahal | satu-satunya jalur sampai true RLHF |
| Together AI (adapter belum ditulis) | SFT + DPO | umumnya lebih murah | berhenti di DPO |

Verifikasi harga & skema API provider terhadap dokumentasi live sebelum run
pertama. Tidak ada biaya apa pun sebelum `TRAINING_API_KEY` di-set dan
`start` dijalankan.

Langkah (semua dari terminal, tanpa GPU/VPS):

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

Saat job sukses, `status` mencatat model `ft:...` sebagai **candidate** di
registry dan mencetak perintah evaluasinya. Lalu:

```bash
npm run eval -- --base-url https://api.openai.com/v1 --model ft:XXXX --api-key-env TRAINING_API_KEY --save model-v1-dpo-XXXX
```

```bash
npm run train -- promote --id model-v1-dpo-XXXX
```

`promote` **menolak** kandidat yang tidak mengalahkan baseline Gemini
(composite ≥ baseline, F1 +2 poin, validitas JSON ≥ 98%, grounding dan
clean-deck tidak turun). Setelah promote, pass teks dilayani model hasil
tuning; pass gambar tetap Gemini. Kalau hasil di produksi mengecewakan:

```bash
npm run train -- rollback --task text
```

---

## Fase D — Sesudahnya (ditunda, jangan dikerjakan sekarang)

- **RFT** (reinforcement fine-tuning dengan grader): aktifkan hanya setelah
  DPO terbukti dan skor grader (`lib/ai/evalScorers.ts`, `GRADER_WEIGHTS`)
  terbukti berkorelasi dengan approval reviewer.
- Capture byte gambar (Vercel Blob privat) untuk training vision.
- Tombol retract rating; UI registry model di `/admin`.

---

## Referensi cepat

Verifikasi (loop dev tanpa API key — lihat README):

```bash
npm run verify:feedback
```

```bash
npm run verify:ui -- scripts/__fixture-deck.pptx
```

```bash
npm run verify:admin -- <adminToken>
```

Semua env var fitur (semuanya opsional; tanpa env = fitur mati):
`ADMIN_TOKEN`, `FEEDBACK_REQUIRE_APPROVAL`, `FEEDBACK_TOKEN_SECRET`,
`TRAINING_CAPTURE`, `TRAINING_CAPTURE_TTL_DAYS`, `TRAINING_PROVIDER`,
`TRAINING_API_KEY`, `TRAINING_BASE_URL`, `TRAINING_MODEL`,
`MODEL_REGISTRY_ENABLED`, `FEEDBACK_PROMPT_MEMORY_TTL_MS`,
`AI_TEXT_*` / `AI_IMAGE_*`. Detail di `.env.example`.
