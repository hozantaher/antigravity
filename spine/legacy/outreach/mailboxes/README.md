# mailboxes

**Status:** scaffold (M1a-e migration in progress)
**Owner:** tomas
**Initiative:** [2026-04-22-discipline-and-domain-migration](../../docs/initiatives/2026-04-22-discipline-and-domain-migration.md)

## Purpose

Správa SMTP/IMAP schránek — registry, selector, warm-up curve, backpressure, bounce tracking, health alerting.

Zdroj pravdy pro `outreach_mailboxes` tabulku. Každé odesílání přes anti-trace-relay bere credentials + send-rate rozhodnutí odsud.

## Public API

9 REST endpoints + 3 events — viz `service.yaml`. OpenAPI kontrakt v `schemas/openapi.yaml`.

## Invariants

1. **Password v DB** (`outreach_mailboxes.password`). Env vars `MAILBOX_N_PASSWORD` jen bootstrap; `SyncFromConfig` DB přebíjí post-bootstrap.
2. **Circuit opens** po 5 SMTP failures v 15min. Auto-resume po 15min silence.
3. **Warmup progression** monotonic: day N+1 vyžaduje 24h úspěchů na day N rate.
4. **Status enum:** `active | warming | paused | bounce_hold | retired`.

## Getting Started

Až do dokončení M1a kód žije v `modules/outreach/internal/mailbox/`, `internal/watchdog/`, `internal/bounce/`. Tato složka = scaffolding pro cílový stav.

Track migrace:
- **M1a** — copy kostra + git mv `internal/mailbox/` → `services/mailboxes/internal/registry/`
- **M1b** — `internal/watchdog/` → `internal/backpressure/`
- **M1c** — `internal/bounce/` → `internal/bounce/`
- **M1d** — UI extract do `@hozan/mailboxes-ui` pnpm package
- **M1e** — finalization + legacy cleanup

## Tests

Baseline per M1a TDD: **443 tests** v `modules/outreach/internal/mailbox/` — same count required after move.
Po migraci: `cd services/mailboxes && go test -race -count=1 ./...`.

## Deploy

Žádný separate Railway service. Hosted inside `machinery-outreach` binary. Per DOMAIN-MAP: Go module per-domain, single deploy target.

## Related Docs

- [DOMAIN-MAP — mailboxes](../../docs/architecture/DOMAIN-MAP.md)
- [DOMAIN-MIGRATION playbook](../../docs/playbooks/DOMAIN-MIGRATION.md)
- [MAILBOX-PASSWORD-UPDATE](../../docs/playbooks/MAILBOX-PASSWORD-UPDATE.md)
- [AUTH-FAIL-ALERT-RESPONSE](../../docs/playbooks/AUTH-FAIL-ALERT-RESPONSE.md)
- [SEND-OPERATIONS](../../docs/playbooks/SEND-OPERATIONS.md)
- memory: `feedback_mailbox_passwords_via_db.md`, `project_quality_debt_summary.md`
