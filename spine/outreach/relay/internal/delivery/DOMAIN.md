# services/relay/internal/delivery/

**Status:** M2.2 marker — domain grouping for outbound SMTP delivery.
See `services/relay/MIGRATION-M2.md`.

## What lives here

Currently delivery/ holds outbound SMTP submit + envelope rewrite. M2.4
consolidates these siblings:

| Sibling pkg   | Move target               | Rationale                          |
|---------------|---------------------------|------------------------------------|
| sanitizer/    | delivery/sanitizer/       | outbound content sanitization      |
| contentenc/   | delivery/contentenc/      | MIME encoding before submit        |

## Current files

Run `ls services/relay/internal/delivery/` for the live list. Update this
DOMAIN.md as packages migrate.

## Why this grouping

Delivery = "how bytes leave the relay into the destination SMTP path".
Separate from intake (how they come in) and transport (wire-level
obfuscation).

## References

- Reorg plan: `services/relay/MIGRATION-M2.md`
