# LLM Reply Classifier — replace keyword whack-a-mole with semantic classification

**Status:** Superseded
**Datum:** 2026-04-27
**Trigger:** LLM classifier roadmap identified; deferred to M+3 per master plan (ADR-006)

## Problem

`humanize.ResponseEngine.ClassifyReply` (the keyword-based reply classifier) misclassifies a non-trivial fraction of real Czech B2B replies because:

- "Děkuji za nabídku, ale momentálně to neřešíme" — clear NO, no negative keyword
- "Cena je vysoká, neberu" — `cena` is in interested-keywords → misclassify positive
- "Vrátím se k tomu, ale teď ne" — `teď ne` Later vs `vrátím se` reads as Interested
- Sarcasm, formality variants, partial sentences, mixed CZ/EN

Result: false-positive leads, sales notified for non-existent interest, opt-outs missed → § 7 zák 480/2004 + GDPR čl. 21 violations.

## Goal

Replace primary classification from keyword → LLM (semantic). Keep keyword as deterministic fallback for:
1. LLM unavailable (Ollama down)
2. LLM low-confidence (< 0.7)
3. CI determinism (tests don't need LLM)

## Existing pieces

| Component | Location | Status |
|---|---|---|
| `humanize.ResponseEngine.ClassifyReply` (keyword) | `features/platform/common/humanize/response.go` | DEPLOYED (post-fix 29f1303) |
| `thread.SentimentClassifier` interface | `features/inbound/orchestrator/thread/inbound.go:16-18` | DEFINED, NOT WIRED |
| `thread.InboundProcessor.WithClassifier(c)` | `features/inbound/orchestrator/thread/inbound.go:44-47` | DEFINED, NOT WIRED |
| `llm.NewClient` (Ollama) | `features/inbound/orchestrator/llm/` | DEPLOYED — used by intel loop |
| `OLLAMA_URL` env var | machinery-outreach env | SET |
| `llmReplyClassifier.js` (JS) | `features/platform/outreach-dashboard/src/lib/` | NOT DEPLOYED (BFF gap) |

## Sprinty

### Sprint A — Go LLM classifier implementation (P0, ~3h)

| ID | Task | Acceptance |
|---|---|---|
| A.1 | Create `features/inbound/orchestrator/llm/reply_classifier.go` implementing `SentimentClassifier` interface | Interface satisfied; compiles |
| A.2 | Prompt design: Czech-aware, 6-class output (interested/meeting/later/objection/negative/ooo), JSON response with confidence | Prompt template tested against 20 hand-curated replies |
| A.3 | Response parser: extract `label` + `confidence` from JSON; reject malformed; map to ReplyType | Property test on malformed responses |
| A.4 | Cache: text hash (sha256) → (ReplyType, confidence) with 1h TTL; sync.Map; bound at 10k entries (LRU) | Unit test: same text twice = one LLM call |
| A.5 | Timeout: 5s per LLM call; on timeout → return error → caller falls back to keyword | Test verifies fallback path |

### Sprint B — Confidence threshold + fallback wiring (P0, ~1h)

| ID | Task | Acceptance |
|---|---|---|
| B.1 | `inbound.go ProcessReply`: when classifier set, call LLM first; on error OR confidence < 0.7, fall back to keyword (`humanize.ClassifyReply`) | Test: low-confidence LLM result not used |
| B.2 | When LLM and keyword DISAGREE on high-confidence LLM (≥ 0.7), use LLM but log slog.Info disagreement with both labels | Test: disagreement logged |
| B.3 | When LLM nil (CI/test mode without Ollama wired), fall back to keyword silently | Existing tests still pass |

### Sprint C — Wire into orchestrator main.go (P0, ~30 min)

| ID | Task | Acceptance |
|---|---|---|
| C.1 | In `cmd/outreach/main.go` server case: if `OLLAMA_URL` set → instantiate `llm.NewReplyClassifier(...)` → `processor.WithClassifier(c)` | Boot log: "reply classifier: LLM enabled" |
| C.2 | Default model = `gemma2:2b` (already used by intel loop), override via `OLLAMA_REPLY_MODEL` | env var honored |
| C.3 | Health surface: `/health.daemons[name=reply_classifier]` flips to `false` if last 10 calls all failed | Test: induce 10 failures, verify daemon health |

### Sprint D — Tests (P0, ~2h)

| ID | Task | Acceptance |
|---|---|---|
| D.1 | Mock Ollama HTTP server fixture for unit tests (existing `llm` package has helpers) | Test file `reply_classifier_test.go` |
| D.2 | Table-driven test: 30 sample Czech B2B replies × expected label, mock Ollama returns the expected JSON, verify pipeline | All 30 pass |
| D.3 | Integration test: real Ollama (skipped when `OLLAMA_URL` unset), 10 hand-curated samples × 0.7 confidence threshold | OPT-IN via `RUN_LLM_TESTS=1` |
| D.4 | Property test: every input produces SOME classification (never panics, always returns valid ReplyType) | fast-check style |
| D.5 | Cache hit test: same text twice = one HTTP call to Ollama | mock counter verified |

### Sprint E — Sample bank + accuracy verification (P0, ~2h)

| ID | Task | Acceptance |
|---|---|---|
| E.1 | Create `docs/test-data/reply-samples.csv` with 100 hand-classified Czech B2B replies covering all 6 classes | curated by Tomáš + me |
| E.2 | Run sample bank through deployed LLM classifier, measure accuracy (correct / total) | ≥ 90% accuracy for ≥ 0.7 confidence; log low-confidence cases |
| E.3 | If accuracy < 90%, iterate prompt + re-test | document in initiative |

### Sprint F — Operator UI for flagging (P1, ~3h, AFTER S9 BFF deploy)

| ID | Task | Acceptance |
|---|---|---|
| F.1 | Reply Inbox UI: "Misclassified?" button on each row | UI component |
| F.2 | POST `/api/replies/:id/reclassify` → updates `reply_inbox.classification` + appends to `misclassification_audit` | Endpoint + DB schema |
| F.3 | Operator dashboard page showing misclassification rate by class | UI page |

### Sprint G — Continuous improvement loop (P2, ongoing)

| ID | Task | Acceptance |
|---|---|---|
| G.1 | Weekly export of misclassified samples to fine-tuning dataset | cron + S3 / DB export |
| G.2 | Quarterly prompt revision based on misclassification analysis | docs/prompts/reply_classifier_v{N}.md |
| G.3 | A/B test old vs new prompts on shadow samples | metric: agreement rate |

## Dependencies

```
A (Go LLM) ─┬─ B (fallback wiring)
            └─ C (main.go wire)
                    │
D (tests) ──┘  ──── E (sample bank + accuracy)
                    │
                    └─ deploy (Railway)
F (UI flag) ─── needs S9 BFF deployed
G (continuous) ─── ongoing
```

## Hard rules

1. NEsendovat na real B2B bez explicit GO (memory `feedback_campaign_send`).
2. LLM classifier MUST have keyword fallback — never let an Ollama outage drop classification entirely.
3. Confidence threshold tuning MUST be data-driven (sample bank), not gut feel.
4. Žádné nové external services — use existing Ollama deployment (memory `feedback_no_external_services`).
5. Sentry observability for every disagreement (not for every classification — would be noisy).

## Sample bank schema (E.1 deliverable)

```
docs/test-data/reply-samples.csv:
  id, text, expected_class, source, notes
  1,  "Nemám zájem.", negative, synthetic, singular
  2,  "Zavolejte mi prosím zítra v 10.", meeting, real-anonymised, ...
  ...
```

100 samples, distribution roughly:
- 30 negative (incl. NBSP, singular, EN, formal/informal)
- 25 interested (incl. price-asking, info-asking)
- 15 meeting (incl. "schůzka", "call", with/without time)
- 10 later
- 10 objection (pushback, but engaged)
- 10 OOO (CZ + EN auto-replies)

## Decision points

| Question | Default |
|---|---|
| Confidence threshold | 0.7 (tunable in env `LLM_CONFIDENCE_THRESHOLD`) |
| Cache TTL | 1h |
| Timeout per LLM call | 5s |
| Model | `gemma2:2b` (matches intel loop default) |
| Sample bank size | 100 (initial), grow over time |
| Disagreement logging level | slog.Info (not Warn — disagreement is normal) |

## Execution order

1. **Tomorrow morning** (autonomous): Sprint A + B + C
2. **Tomorrow afternoon**: Sprint D
3. **After deploy**: Sprint E (with Tomáš helping curate samples)
4. **Post BFF deploy** (S9): Sprint F
5. **Ongoing**: Sprint G

## Send log

| Date | Recipient | Outcome | Envelope ID |
|---|---|---|---|
| 2026-04-27 19:06:12 UTC | b.maarek@email.cz (mb=631) | DELIVERED | env_34b756aa48f4f886ca28728b — direct relay |
| 2026-04-27 20:00:01 UTC | a.mazher@email.cz (mb=3 self) | DELIVERED | env_dbe900dbfdff2bed041c3be8 — campaign 456 |
| 2026-04-27 20:04:18 UTC | b.maarek@email.cz (mb=631) | FAILED | env_1657e3481268bd87ada0d174 |
