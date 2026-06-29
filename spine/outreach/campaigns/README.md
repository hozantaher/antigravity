# services/campaigns/

**Status:** M3.1 scaffold. Migration tracked in `MIGRATION-M3.md` + `docs/initiatives/2026-04-22-discipline-and-domain-migration.md`.

## What this owns

The campaign send pipeline end-to-end:
- Campaign CRUD + state machine (`campaign/`)
- SMTP send engine (`sender/`)
- Mailbox warmup / daily-cap ramp (`warmup/`)
- Message-body token replacement (`token/`)

Related but NOT in this service:
- Mailbox credentials + health → `services/mailboxes/`
- SMTP transport + proxy rotation → `services/relay/`
- Reply classification → `services/inbox/`

## Migration phases

| Phase | What | Status |
|-------|------|--------|
| M3.1  | `services/campaigns/` scaffold + service.yaml + MIGRATION-M3.md | **in-progress** |
| M3.2  | Promote `campaign/`, `sender/`, `warmup/`, `token/` out of `internal/` | planned |
| M3.3  | Move `/api/campaigns/*` handlers out of `internal/web/` | planned |
| M3.4  | Separate `go.mod`, register in `go.work` | planned |

## Dependencies

Upstream: `mailboxes` · `relay` · `outreach/humanize` · `contacts`
Downstream: `intelligence` · `dashboard`

## Invariants (MUST hold)

- No duplicate send per (contact_id, campaign_id, step_id) — CAS gate in runner
- Preflight green before status=active (T-U01 gate, `preflight.go`)
- Warmup respects mailbox daily cap
- Send window CZ working hours only (08:00–17:00 Europe/Prague)

## SLO

| Metric | Target |
|--------|--------|
| Availability | 99.0% |
| Preflight latency p95 | < 500 ms |
| Send attempt p95 | < 4000 ms (relay + SMTP) |

## Tests

Until M3.2 completes, tests live in `modules/outreach/internal/{campaign,sender,warmup,token}/` and run via `go test ./...` from `modules/outreach/`.
