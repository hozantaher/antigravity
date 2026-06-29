# services/inbox

## Stack
Go 1.25, PostgreSQL, sqlmock. Test: `go test`.

## Purpose
Reply intake + classification. Consumes the IMAP poller's output
(orchestrator/imap), classifies replies (positive / negative /
auto_reply / question / unknown), and drives the `reply_inbox` table
that the operator dashboard reads.

## Subpackages
- `reply/` — classification + `reply_inbox` CRUD.
- `web/` — HTTP handlery (`threads.go`) pro thread list/detail; mountuje orchestrator.
- `ui/` — React zdrojáky (legacy ostrov); aktuální operator surface je `apps/outreach-dashboard/src/pages/Replies.jsx`.

## Hot files
- `reply/classify.go` — regex-based classifier (positive/negative/auto/question/unknown). 100% coverage.
- `apps/outreach-dashboard/src/lib/llmReplyClassifier.js` (NOT in this service, but related) — LLM-backed semantic classifier (BF-D3). Falls back to the regex classifier in `reply/classify.go` when LLM is disabled or low-confidence.

## Schema
`reply_inbox`:
- `send_event_id INT UNIQUE REFERENCES send_events(id)` — joins back to the originating send.
- `classification TEXT` — one of the 5 labels above. NULL until classifier runs.
- `handled BOOLEAN`, `handled_at TIMESTAMPTZ` — operator marks via dashboard.

## Conventions
- Classifier is **deterministic** — same body → same label. No randomness, no time-dependence.
- `MIGRATION-M5.md` documents the schema evolution; consult before changing columns.

## Testing
- `go test ./...` — 40+ tests across 2 packages (`reply`, `web`); `classify.go` at 100% coverage.

## Don't
- Don't add a new classification label without updating the operator UI dropdown + the LLM prompt in `llmReplyClassifier.js`. The two must agree on the closed vocabulary.
- Don't classify via LLM only — regex fallback is required for production reliability (BF-D3 contract).
