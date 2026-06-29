# services/mailboxes

## Stack
Go 1.25, PostgreSQL, Sentry, sqlmock. Test: `go test`.

## Purpose
Owns the `outreach_mailboxes` table and everything that touches sender
mailbox state: warmup ramps, bounce throttling, advisory hold/release,
per-mailbox alerts. Password storage is currently plaintext v koloně
`outreach_mailboxes.password` (migration 038); pgcrypto/AES-GCM column
encryption je plánovaný follow-up — viz S5 playbooky a kommentář
v `mailbox/mailbox.go` (`Password` field).

## Subpackages
- `bounce/` — bounce-rate computation + flip logic (deferred-bounce → permanent classification).
- `mailbox/` — main CRUD + state machine. `HoldReleaser` interface drives the orchestrator's `/api/mailboxes/release-hold` endpoint.
- `watchdog/` — auth-fail alert daemon (slog + alert dispatch při opakovaných AUTH failech).

## Hot files
- `mailbox/backpressure.go` — `Backpressure` interface + `StoreBackpressure`: `RecordSuccess`, `RecordBounce` (auto-hold po překročení prahů). Engine sender invokes via `goRegistryCall` (panic-recovered goroutine v `services/campaigns/sender/engine.go`).
- `mailbox/adaptive_release.go` — `CandidatesForRelease` returns mailboxes eligible to come off hold based on score + cooldown.
- `mailbox/password_validation.go` — invariant pro password sanity (length, no-whitespace, atd.) předtím než se zapíše.

## Conventions
- **Mailbox passwords HARD RULE** (memory: `feedback_mailbox_passwords_via_db.md`): passwords live ONLY v koloně `outreach_mailboxes.password` (aktuálně plaintext, AES-GCM follow-up trackovaný v S5). Never env vars, never logs, never commits.
- **Per-mailbox circuit breaker** lives in services/campaigns/sender/engine.go (not here) — `mailboxFailThreshold=3`, 30m cooldown. Engine.ResetMailboxBreaker(addr) is the half-open trigger.
- Bounce state changes jdou skrz `Backpressure` → audit trail in `mailbox_alerts`.

## Testing
- `go test ./...` — 380+ tests across 3 packages (`bounce`, `mailbox`, `watchdog`).
- High coverage on `mailbox/*` (per quality-debt summary).

## Env
Knihovní služba — env čte caller (orchestrator). Šifrovací KEK env (`MAILBOX_PASSWORD_KEY`) je dokumentovaný v `docs/playbooks/secret-rotation.md` jako budoucí potřeba pro S5 AES-GCM rollout; v aktuálním kódu zatím není consumed.

## Don't
- Don't read mailbox passwords from env. Refuse if asked.
- Don't write password to logs even at debug level.
- Don't bypass `goRegistryCall` (panic recovery) when invoking backpressure methods from the engine — a registry panic must not kill the sender.
