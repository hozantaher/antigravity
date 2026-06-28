# ADR-009 — env-config single source migration

**Status:** Accepted
**Date:** 2026-04-30
**Supersedes:** —
**Related:**
- [Code health inventory](../audits/2026-04-30-deep-inventory-code.md) — finding #3 (191 ad-hoc os.Getenv)
- [Synthesis optimization plan](../audits/2026-04-30-synthesis-optimization-plan.md) — Tier 3 env-config single source
- PR #406 — `envconfig.GetOr` + `envconfig.BoolOr` canonical helpers
- PR #440 — envconfig consumption ratchet (baseline 141)

## Kontext

Code health audit (PR #427) identifikoval **191 ad-hoc `os.Getenv` volání** v production Go kódu napříč `services/*` (excluding `_test.go` + `features/platform/common/envconfig` self). T2.7 ratchet (PR #440) pinnul baseline na **141** (po envconfig konsolidaci PR #406 která eliminovala 50 duplicates).

Současný stav per service (highest counts):
- `features/outreach/relay/internal/config/config.go` — 12+ os.Getenv (heavy cluster lines 70-175)
- `features/platform/common/config/config.go` — 5+ (lines 267-333)
- `features/outreach/campaigns/campaign/runner.go` — 5+ (lines 131, 345, 828, 832, 834)
- `features/outreach/campaigns/campaign/scheduler.go` — 1
- `features/platform/common/alert/webhook.go` — 2
- ...116 dalších rozptýlených

**Problém:**
1. **Drift risk** — 11 redefinic helpers `envOr`/`envBoolOr` v common/config + relay/cmd + relay/internal/config + privacy-gateway. PR #406 eliminoval 7, ale 4+ míst zůstává.
2. **Boolean dialect inkompatibility** — `strconv.ParseBool` (rejects `yes`/`on`) vs `1|true|yes|on` allow-list (PR #406 sjednotil dialect).
3. **No validation surface** — bare `os.Getenv` returns "" silently when missing. Boot doesn't fail-fast.
4. **Audit gap** — žádný central registry "kdo čte které env var".

## Rozhodnutí

### D1 — All production env reads přes `features/platform/common/envconfig`

`features/platform/common/envconfig` je single canonical API:
- `GetOr(key, fallback string) string` — string with fallback
- `BoolOr(key string, fallback bool) bool` — boolean with `1|true|yes|on` dialect
- `MustHave(key string) string` — required, panics at boot if missing
- `Required(...)` schema builder + `MustValidate(s)` boot validation (existing BF-G4)

Žádné `os.Getenv` v production code. Allow-list comment `// envconfig-allowed: <důvod>` pro explicit exceptions (např. `os.Getenv("HOME")` v cmd entry-points).

### D2 — Per-service migration (8 sprintů)

Per ratchet baseline (PR #440), každý merge musí baseline LOWER NEBO same. Migrace = postupné PRs:

| Order | Service | os.Getenv count | Sprint |
|---|---|---|---|
| 1 | `features/outreach/relay/internal/config/config.go` | 12+ | T3.A.1 |
| 2 | `features/outreach/relay/cmd/relay/main.go` | varies | T3.A.2 |
| 3 | `features/platform/common/config/config.go` | 5+ | T3.A.3 |
| 4 | `features/outreach/campaigns/campaign/runner.go + scheduler.go` | 6+ | T3.A.4 |
| 5 | `features/outreach/campaigns/sender/*.go` | varies | T3.A.5 |
| 6 | `features/inbound/orchestrator/cmd/outreach/main.go` | 2+ | T3.A.6 |
| 7 | `features/acquisition/contacts/...` | varies | T3.A.7 |
| 8 | `services/{mailboxes,inbox,scrapers,worker}/...` | misc | T3.A.8 |

Po 8 sprintech: ratchet baseline ~0-10 (jen sanctioned exceptions).

### D3 — Migration recipe per call-site

```go
// Before
v := os.Getenv("FOO_BAR")
if v == "" { v = "default" }

// After
v := envconfig.GetOr("FOO_BAR", "default")
```

```go
// Before (boolean)
v := os.Getenv("FEATURE_X") == "1" || os.Getenv("FEATURE_X") == "true"

// After
v := envconfig.BoolOr("FEATURE_X", false)
```

```go
// Before (required, no fallback)
v := os.Getenv("DATABASE_URL")
if v == "" { log.Fatal("DATABASE_URL required") }

// After
v := envconfig.MustHave("DATABASE_URL") // panics with consistent error
```

### D4 — Allow-list pattern

Pro legitimate exceptions (e.g. `os.Getenv("HOME")` v cmd, system-bootstrap reads):

```go
// envconfig-allowed: cmd entrypoint reads HOME for default config path
homeDir := os.Getenv("HOME")
```

Ratchet test parsuje 3 řádky nad call site na `envconfig-allowed:` marker; pokud match → skip count.

### D5 — Per-service Required(...) schema

Každý service `cmd/<svc>/main.go` musí na boot volat:

```go
schema := envconfig.Required(
    envconfig.Var{Name: "DATABASE_URL", Required: true},
    envconfig.Var{Name: "OUTREACH_API_KEY", Required: true},
    envconfig.Var{Name: "GO_SERVER_URL", Default: "http://localhost:8080"},
    // ...
)
envconfig.MustValidate(schema)
```

Boot fail-fast pokud required missing. Default values centralized v one place per service.

## Důsledky

### Pozitivní

- 191 → ~10 os.Getenv sites (postupné, ratchet-enforced)
- Single canonical dialect pro boolean parsing
- Boot fail-fast na missing required env vars
- Per-service env contract documentable (schema = sssingle source)
- Operator runbook může extract env list automatically

### Negativní

- 8 PRs ceremony cost (~5 min/PR × 8 = 40 min)
- Mid-state inconsistency během migrace (some services migrated, some not)
- Allow-list comments add visual noise (mitigated: rare)

### Neutrální

- No behavior change pro production (same env vars, same defaults, same fallbacks)
- Test count nepřímo affected

## Recovery procedura

Pokud po migrace some service crashes na boot:

1. Identifikuj missing env var via panic message (`MustHave` failure)
2. Set env var v Railway dashboard nebo .env
3. Pokud env var není vyžadována → revert sprint, mark Var.Required=false v schema
4. Re-deploy

## Rejected alternatives

### A — Big-bang full migration single PR

Rejected: 191 sites = high regression risk, single PR review hard.

### B — Defer to post-M+3

Rejected: ratchet baseline 141 = ongoing drift risk. Each new service contribution adds os.Getenv → drift accelerates.

### C — Lint-only enforcement (golangci-lint custom rule)

Rejected: ratchet test (PR #440) je already in place, rune při každém PR. Lint duplicate effort.

## Implementation plan

| Sprint | Obsah | Status |
|---|---|---|
| T3.A.1 | relay/internal/config | M+1 |
| T3.A.2 | relay/cmd/relay | M+1 |
| T3.A.3 | common/config | M+1 |
| T3.A.4 | campaigns/campaign | M+2 |
| T3.A.5 | campaigns/sender | M+2 |
| T3.A.6 | orchestrator/cmd | M+2 |
| T3.A.7 | contacts/* | M+3 |
| T3.A.8 | mailboxes/inbox/scrapers/worker | M+3 |

Each sprint:
- Single PR `chore(envconfig): migrate <service>`
- Lower ratchet baseline by exact count
- All package tests stay green
- Boot validation schema added pokud applicable

## Reference

- ADR-006 — Ollama Railway deployment (boot env var pattern reference)
- BF-G4 — `features/platform/common/envconfig` boot validation (existing primitive)
- PR #406 — `envconfig.GetOr`/`BoolOr` canonical helpers
- PR #440 — consumption ratchet
- PR #427 — code health inventory s 191-count finding
