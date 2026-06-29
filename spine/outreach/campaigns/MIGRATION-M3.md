# M3 Campaigns Migration Plan

**Status (2026-04-23):** M3.1 scaffold ✅, M3.2 all 4 sub-pkgs public ✅ (warmup/token/sender/campaign), **M3.3 campaigns + segments web handler carve ✅**. M3.4 go.mod pattern also ✅ (services/campaigns/go.mod registered in go.work). Owner: tomas. Target: 2026-05-06.

**Implementation note — how M3.3 was pragmatically solved:**
Handlers placed at `services/campaigns/web/` (public, NOT `internal/web/`)
because `modules/outreach/web` must import them and Go's internal/ rule
blocks cross-module internal imports. Thin Server-receiver adapters remain
in `modules/outreach/web/{campaigns,segments}.go` to preserve legacy test
compatibility. New code calls `campaignsweb.Handle*` directly.

**M-prep COMPLETE** — all 18 packages out of `modules/outreach/internal/`.
The Server struct (`outreach/web`) is now publicly importable. M3.3 handler
carve depends only on a Deps/DI refactor (no more Go internal/ blocker).

## Goal

Carve the campaign send pipeline out of `modules/outreach/internal/` into
`services/campaigns/`, mirroring M1 (mailboxes) and M5 (inbox). Preserve
all tests via baseline same-count verification.

## Source packages (in modules/outreach/internal/)

| Pkg         | LoC    | Tests (files) | Owner-after                | Notes                                 |
|-------------|--------|---------------|----------------------------|---------------------------------------|
| campaign/   | ~3500  | 6             | services/campaigns/campaign | State machine + preflight + runner    |
| sender/     | ~2800  | 5             | services/campaigns/sender   | SMTP send + circuit breaker           |
| warmup/     | TBD    | TBD           | services/campaigns/warmup   | Ramp + daily cap                      |
| token/      | TBD    | TBD           | services/campaigns/token    | Message placeholder substitution      |

Web handlers for `/api/campaigns/*` (~15 endpoints) live in
`modules/outreach/internal/web/` and move in M3.3.

## Cross-module risk

campaign package imports:
- `outreach/internal/mailsim` — move or shared?
- `outreach/internal/sender` — internal dep; both move together
- `outreach/internal/humanize` — already public ✅ (M5 prep)
- `outreach/internal/alert` — already public ✅ (M5 prep)

sender package imports:
- `outreach/internal/warmup` — internal dep; both move together
- `outreach/internal/protections/probe` — shared primitive; promote separately in M3.2a

## Phased rollout

### M3.2a: promote warmup + token (leafs, no internal consumers outside campaign)

Start with leafs — they have the smallest blast radius. Pattern proven 6× in
M5 prep (health/humanize/alert/imap/thread/llm):

```bash
git mv modules/outreach/internal/warmup modules/outreach/warmup
rtk grep -rln "outreach/internal/warmup" --include="*.go" | xargs sed -i '' 's|outreach/internal/warmup|outreach/warmup|g'
cd modules/outreach && go build ./... && go test -count=1 ./...
```

Baseline test count: capture before, verify after.

### M3.2b: promote sender

Sender depends on warmup (done in 3.2a) + alert (done) + humanize (done) +
protections (still in internal/). Decision gate:
- If sender only uses `protections/probe` helpers read-only → can stay in internal while sender becomes public (one-way import: internal → public is fine).
- If sender uses `protections` writers → promote protections first.

Investigate with:
```bash
rtk grep -n "protections\." modules/outreach/internal/sender/*.go | head
```

### M3.2c: promote campaign

Biggest package. Depends on all of the above being public. Should be
mechanical once sub-deps are promoted.

### M3.3: web handlers

Move `/api/campaigns/*` from `internal/web/server.go` into a new
`services/campaigns/internal/web/` package. Dashboard BFF continues to own
the Express router; this is only about the Go-side handler location.

### M3.4: separate go.mod + go.work replace

Final step — `services/campaigns/` gets its own `go.mod`. The
`modules/outreach/go.mod` adds a `replace` directive so consumers (cmd +
intelligence) see the new module path transparently. Pattern proven in
services/mailboxes M1d.

## Test invariants

- Total Go test count in repo MUST NOT decrease across any M3.x commit.
- No internal/ cross-module imports (Go enforces; our `go build` is the gate).
- Each M3.x phase ships in its own commit with a baseline-count line in
  the commit message (e.g., "Tests: 2528 pass / 33 pkg — no drift").

## Out of scope

- Classify pkg (ICP/sector/region) — belongs to M4 (contacts).
- Intelligence loop — M5.5, its own milestone.
- UI refactor from `apps/outreach-dashboard/src/pages/Campaigns.jsx` into
  `services/campaigns/ui/` — M6 (dashboard shell cleanup) tracks this.

## Cross-branch signals (A → B / B → A)

- A → B: `Needs-Tests: services/campaigns/warmup M3.2a regression suite`
- A → B: `Needs-Tests: services/campaigns/sender M3.2b circuit-breaker property test`
- B → A: `Resolves-Trailer: Needs-Tests: services/campaigns/warmup`
- A → B: `Breaks-Contract: none` (each phase is a rename + re-export; no API shape change expected)

## References

- Mirror of `services/inbox/MIGRATION-M5.md`
- Mirror of M1 pattern (mailboxes commits `ea9afa5` → `M1a.2`)
- `docs/architecture/DOMAIN-MAP.md#campaigns`
- `docs/playbooks/DOMAIN-MIGRATION.md` (general procedure)
