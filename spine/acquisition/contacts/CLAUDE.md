# services/contacts

## Stack
Go 1.25, PostgreSQL (`lib/pq`), Sentry, sqlmock. Test: `go test`.

## Purpose
Owns everything to do with B2B prospect contacts:
sourcing from public registries (ARES, firmy.cz), enrichment,
classification, suppression. The campaign engine queries this service's
schema for eligible recipients.

## Subpackages
- `ares/` — ARES public-registry fetcher (Czech business registry; legal data source per LIA).
- `auditenrich/` — enrichment audit log + healing log writers.
- `category/` — category-tree taxonomy + matching logic.
- `classify/` — contact classification (industry, size, region) for scoring.
- `company/` — `companies` table CRUD + metadata snapshot/sync.
- `contact/` — Schema A `contacts` table CRUD + status vocabulary (`new`, `valid`, `opened`, `clicked`, `replied`, `suppressed`, `blacklisted`).
- `enrichment/` — `SuppressEmail/Domain` + `RunSuppressInactive` + cross-schema sync. **Hot file**: `suppress.go` writes to `outreach_suppressions` (Schema B) + `outreach_contacts.status='suppressed'` + `outreach_threads` cascade. Migration 005 (BF-E3) adds the `contacts.status` mirror via INSERT trigger.
- `exclusion/` — competitor/blocked-domain rules.
- `lead/` — lead funnel state machine.
- `prospect/` — prospect dataset import (firmy.cz, dedupe, normalisation).
- `segment/` — segment query builder used by campaign runner pro výběr příjemců.
- `validation/` — email validation pipeline (syntax, MX, disposable, spamtrap, SMTP probe).
- `web/` — HTTP handlers (mounted by orchestrator).
- `internal/blockdetect/` — block / soft-rejection detection from SMTP probe replies.
- `internal/enrichment/` — interní helpery sdílené mezi enrichment + ares.

## Hot files
- `enrichment/suppress.go` — single source of suppression writes. **Always** writes to `outreach_suppressions`; the BF-E3 trigger mirrors to `contacts.status`.
- `validation/verifier.go` + `validation/smtp_probe.go` — email-verify pipeline (syntax → MX → disposable → spamtrap → SMTP probe). Per-domain rate-limiting + soft/hard reject classification.
- `validation/mx.go` — DNS MX cache; `VALIDATION_LIVE_DNS=1` přepíná na real DNS lookups (default je stub).
- `prospect/firmy.go` (+ `prospect/integration_test.go`) — firmy.cz CSV/SQL importer; expects `FIRMY_DSN` env pro ostrý import.

## Conventions
- Schema A vs B: `contacts` (legacy A) and `outreach_contacts` (Schema B) are joined via `email_hash = encode(sha256(email::bytea), 'hex')`. Every read of suppression UNIONs both `outreach_suppressions` + `suppression_list` (memory: `project_two_suppression_tables.md`).
- Contact statuses are a closed vocabulary — don't introduce new values without auditing every read site.
- ARES + firmy.cz fetchers are rate-limited; never blast.

## Testing
- `go test ./...` — 1200+ tests across 15 packages.
- sqlmock for DB; `enrichment/suppress_*_test.go` covers the cascade contract.

## Env
Tato služba je knihovna (žádný vlastní `cmd/main.go`); env vars čte caller (orchestrator/BFF).
Test-only env vars přímo v kódu:
- `TEST_OUTREACH_DSN` — DSN pro integration testy (jinak skip).
- `FIRMY_DSN` — DSN pro `prospect/integration_test.go` (firmy.cz import).
- `VALIDATION_LIVE_DNS=1` — povolí ostré DNS lookupy ve `validation/`; jinak stub.
EMAIL_VERIFY_FROM / EMAIL_VERIFY_SMTP env vars patří k BFF SMTP-probe wrapperu (`apps/outreach-dashboard/server.js`), ne k téhle službě.

## Don't
- Don't update `outreach_contacts.status` directly — go through `SuppressEmail` so the mirror trigger fires.
- Don't bypass `_domainProbeLock` — MX servers throttle aggressive probing.
- Don't fetch ARES/firmy.cz outside the sanctioned data sources (memory: `project_proxy_sources.md`).
