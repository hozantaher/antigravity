# Classifier Accuracy Audit Playbook

**Sprint:** B2 — LLM reply classifier ground-truth verification  
**Owner:** Tomáš (operator labeling), Chat B (harness + scoring)  
**Target:** ≥90% accuracy at confidence ≥0.7

---

## Overview

The LLM reply classifier assigns a label to every inbound email reply:

| Label | Meaning |
|-------|---------|
| `interested` | Wants more info, asks about price/catalog |
| `meeting` | Wants to schedule a call or meeting |
| `later` | Neutral postpone — will revisit |
| `objection` | Has concerns but remains engaged |
| `negative` | Not interested, unsubscribe, refusal |
| `ooo` | Out-of-office, auto-reply |

This playbook defines how to sample 20 classified replies, label them manually, and compute accuracy so we know whether the LLM is calibrated well enough for production.

---

## Step 1: Generate the sample CSV

From `features/platform/outreach-dashboard/`:

```bash
pnpm run audit:classifier-sample
```

This queries the 20 most-recent classified inbound replies from `outreach_messages` and writes a CSV to:

```
reports/classifier-accuracy/YYYY-MM-DD-classifier-sample.csv
```

If the table has fewer than 20 classified rows, all available rows are exported. If there are no classified rows yet (no LLM-classified campaigns have run), the script prints a warning and writes an empty CSV.

**PII note:** Sender emails are replaced with `mb1@redacted`, `mb2@redacted`, etc. — ordinals are stable within a single run but do not correspond to specific mailboxes across runs.

---

## Step 2: Label the CSV (operator task, ~30 min)

1. Open the CSV in Numbers, Excel, or Google Sheets.
2. For each row, read the `body_truncated_400c` (and `subject_truncated_80c`) columns.
3. Fill in the `ground_truth_label_BLANK` column with your best label.
   - Use only the valid labels: `interested`, `meeting`, `later`, `objection`, `negative`, `ooo`
   - If the reply is truly ambiguous, use the label you would have used for routing
4. Optionally add notes in the `notes_BLANK` column.
5. Save the file as CSV (same filename, or a new name).

**Important:** The `llm_confidence` column will be blank in this version — the classifier does not yet persist confidence scores. Leave it blank.

---

## Step 3: Compute accuracy

```bash
pnpm run audit:classifier-score <path-to-filled-csv>
```

Example:

```bash
pnpm run audit:classifier-score reports/classifier-accuracy/2026-05-05-classifier-sample.csv
```

The script:

1. Reads the filled CSV
2. Skips rows where `ground_truth_label_BLANK` is still empty
3. Computes overall accuracy + per-label precision/recall/F1
4. Builds a confusion matrix (LLM prediction × ground truth)
5. Writes a Markdown report to:
   ```
   reports/classifier-accuracy/YYYY-MM-DD-classifier-score.md
   ```
6. Exits with code `1` if overall accuracy < 90% (so CI can gate on it)

---

## Interpreting results

### Target: ≥90% overall accuracy

- **Met:** LLM calibration is acceptable for production. Optionally review low-recall labels to see if prompt improvements are low-hanging fruit.
- **Not met:** Review the confusion matrix — which (prediction, ground-truth) pairs have the most errors? Use these as concrete examples to improve the classifier prompt in `features/inbound/orchestrator/llm/classify.go`.

### Per-label precision and recall

- **Low recall on `negative`:** LLM is missing unsubscribe/refusal replies — highest business risk (missed suppressions).
- **Low precision on `interested`:** LLM is hallucinating interest — misleads operators into prioritizing noise.
- **Low recall on `ooo`:** OOO replies may trigger unwanted sequence responses instead of a 14-day pause.

### Confidence breakdown

Currently the classifier does not store per-reply confidence scores in the database. When confidence tracking is added (planned for KT-B3), the scoring script will automatically populate this section.

---

## File locations

| File | Description |
|------|-------------|
| `scripts/audits/classifier-accuracy.mjs` | Sample generator — reads DB, writes CSV |
| `scripts/audits/classifier-score.mjs` | Scorer — reads filled CSV, writes Markdown report |
| `reports/classifier-accuracy/` | Output directory for CSVs and score reports |
| `features/inbound/orchestrator/llm/classify.go` | Classifier prompt (edit here to improve labels) |
| `features/inbound/orchestrator/thread/inbound.go` | Where `reply_type` is written to `outreach_messages` |

---

## Running without pnpm (direct node invocation)

From the repo root:

```bash
node --env-file-if-exists=features/platform/outreach-dashboard/.env \
  features/platform/outreach-dashboard/scripts/audits/classifier-accuracy.mjs

node features/platform/outreach-dashboard/scripts/audits/classifier-score.mjs \
  reports/classifier-accuracy/2026-05-05-classifier-sample.csv
```

The scripts auto-discover `.env` from several relative paths. `DATABASE_URL` must be available in the environment or `.env`.

---

## Cadence

Run this audit:

- After the first 20 LLM-classified replies land in production
- Whenever the classifier prompt in `classify.go` is changed
- When KT-B3 (confidence tracking) ships — re-run to baseline the new confidence column

See `docs/initiatives/2026-04-27-llm-reply-classifier.md` for the broader classifier roadmap.
