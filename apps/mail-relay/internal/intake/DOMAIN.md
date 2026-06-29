# services/relay/internal/intake/

**Status:** M2.2 marker — domain grouping for intake (HTTP API + auth).
See `services/relay/MIGRATION-M2.md`.

## What lives here

Currently intake/ holds /submit + /v1/proxy-pool + /v1/auth-check request
shaping. M2.4 consolidates these siblings:

| Sibling pkg   | Move target               | Rationale                           |
|---------------|---------------------------|-------------------------------------|
| httpapi/      | intake/httpapi/           | public HTTP endpoints               |
| auth/         | intake/auth/              | request auth (API keys, not SMTP)   |
| duress/       | intake/duress/            | duress-code authentication          |
| admin/        | intake/admin/             | operator-only endpoints             |

## Current files

Run `ls services/relay/internal/intake/` for the live list. Update this
DOMAIN.md as packages migrate.

## Why this grouping

Intake = "how bytes get into the relay". Distinct from delivery (out to
SMTP) and transport (wire-level).

## References

- Reorg plan: `services/relay/MIGRATION-M2.md`
