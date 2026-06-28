# Inventory: Testing Infrastructure

Comprehensive audit of test scopes, configurations, fixtures, and helpers across frontend (Vitest) and backend (Go) services.

---

## Frontend Testing (features/platform/outreach-dashboard)

### Test Organization

Single unified **vitest.config.ts** with TEST_SCOPE env switching.

| Scope | Command | Pattern | Environment |
|-------|---------|---------|-------------|
| **default** | `pnpm test` or `pnpm test:fast` | unit + audit + chaos + property + regression + synthetic | jsdom |
| **contract** | `pnpm test:contract` | BFF mocks (vi.mock pool, supertest) | node |
| **integration** | `pnpm test:integration` | Real DB (pg-mem), migrations | node |
| **all** | `pnpm test:full` or `pnpm test:all` | All scopes except legacy real-server | jsdom |
| **e2e** | `pnpm e2e` | Playwright (separate config) | Chromium |

**Config file:** `/features/platform/outreach-dashboard/vitest.config.ts` (lines 1-102)  
**Env loading gotcha:** `env: { BFF_AUTH_DISABLED: '1' }` auto-set for contract scope (line 91)  
**Coverage thresholds:** 80% (lines, functions, branches, statements)  
**Retry strategy:** On CI (`CI=true`), 1 retry per test; local dev runs without retry to expose flakiness immediately (line 95)

### Test Directories (337 files total)

```
tests/
├── unit/              # 200+ tests (components, hooks, lib, pages, scripts, legacy)
├── contract/          # BFF contract tests (mocked Go backend)
├── integration/       # pg-mem real DB tests (migrations, schema validation)
├── audit/             # Discipline ratchet checks (observability, explanation)
├── chaos/             # Markov sims + multi-entity invariants
├── property/          # fast-check property tests
├── synthetic/         # PROD continuous monitoring (Phase 3, planned)
├── regression/        # Incident replay (Phase 4, planned)
├── e2e/               # Playwright specs
├── fixtures/          # Seeded test data (migrations)
└── helpers/           # Shared test infrastructure
```

### Vitest Setup Files

**Unit/Default:** `/src/test/polyfill.js`, `/src/test/setup.js`  
**Contract:** `/tests/contract/setup.ts` (vi.mock of Go pool)

---

## Test Helpers & Fixtures

### Shared Helpers (/tests/helpers/)

**slo-helpers.js** (96 lines)
- `percentile(values, p)` — Linear interpolation (NIST method)
- `assertPercentile(values, p, bound)` — SLO validation
- `assertHistogramBounded(values, bounds)` — Multi-percentile checks (p50, p90, p99, p999)
- `assertConvergence(seq, opts)` — Rolling variance validation
- `assertMonotonic(seq, direction)` — Monotonicity enforcement
- `assertNoStateOscillation(trace, maxVisits)` — State-visit count ratchet

Used by: HX5 (SLO histograms), HXX3 (percentile bounds), HX3/HX4 (convergence)

**chaos-sim.js** (480 lines)
- `FaultInjector` — Centralized fault registry (event-based `rate_per_n`, time-based `rate_per_h/d`)
- `FakeClock` — Deterministic time advance (no real timers)
- `MarkovSim` — Markov chain simulator with state tracking, fault transitions, recovery triggers
- `ShadowRunner` — Counterfactual analysis (primary vs shadow state path comparison)

Seeded PRNG (mulberry32) mirrors `src/lib/spintax.js` for reproducibility.  
Used by: HX3, HX4, HXX2, HXX4 (chaos tests), HXX8 (advanced invariants)

**state-machine.js** (283 lines)
- `StateGraph` — Directed graph of allowed state transitions
  - `addEdge(from, to, meta)` — Register transition
  - `canTransition(from, to)` — Boolean check
  - `markAbsorbing(state)` — Terminal states
- `exhaustiveCheck(sg, startState, maxDepth, predicate)` — BFS enumeration of reachable traces
- `randomTraversal(sg, startState, length, seed)` — Sampled traversal (deterministic seed)
- `assertInvariant(sg, startState, predicate, opts)` — Predicate-based assertion with counterexample trace
- `assertReachable(sg, from, to)` — Path existence check
- `assertAbsorbing(sg, state)` — Terminal-state validation

Mailbox state reference: `features/outreach/campaigns/sender/engine.go` → {active, paused, warming, retired, needs_human}  
Used by: HX2 (anti-thrash), HX8 (formal invariants), HXX8 (advanced invariants)

**heal-fixtures.js** (368 lines)
- `makeMockMailbox(opts)` — Mailbox state + healingLog tracking
  - `recordSmtpFailure(info)` — SMTP failure logging
  - `simulateAutoPause()` — 3-strike auto-pause
  - `simulateCooldownExpiry()` — Recovery + cooldown reset
  - `snapshot()` — Immutable state snapshot
- `makeMockCron(opts)` — Cron guard with error injection
  - `injectError(err)` — Pending error to throw on next tick
  - `tick()` → `heartbeat()` — Cron execution tracking
- `makeMockEngine(opts)` — Engine daemon state
  - `run()` — Dispatch increment, last_seen_at refresh
  - `injectPanic()` → `supervisorRestart()` — Health state transitions
- `snapshotState(src)` — Deep-freeze JSON-shaped snapshot
- `diffSnapshots(a, b)` — Diff report (added/removed/changed leaves)

Schema mirrors production `healing_log` table (id, entity_type, entity_id, entity_label, action, reason, resolved_at, created_at)  
Passwords intentionally NOT modeled (production rule: DB-only secrets)

**flaky-quarantine.js** (52 lines)
- `recordRun(history, run)` — Run history tracking (max 100 entries)
- `rollingFailureRate(runs, window)` — Failure% in last N runs
- `shouldQuarantine(runs, opts)` — ≥3 fails in last 10 runs
- `shouldRestore(runs, opts)` — 3 consecutive passes restore

State file: `flaky_quarantine.json` (CI-managed)

---

## Audit Tests (Discipline Ratchets)

**Purpose:** Enforce code quality invariants via test counts (never grow, only shrink).

### heal-slo.test.js (HX5)
- Synthetic 1000 heal events → histogram bounds assertion
- Production SLOs:
  - Mailbox recovery: P50 <2min, P99 <15min
  - Cron stall: P50 <30s, P99 <2min
  - Proxy pool refresh: P99 <90s
- Uses: `buildHistogram()` (controlled seed PRNG), `assertHistogramBounded()`

### observability-audit.test.js (HX10)
- **Meta-test:** Mirrors `features/outreach/campaigns/sender/slog_op_audit_test.go`
- Scans source files (no AST, sticky regex) for self-heal call sites
- Enforces 5 observability surfaces per heal site:
  1. slog/console logs with `op` field
  2. Prometheus/BFF metrics counter
  3. Sentry breadcrumb/event
  4. healing_log DB insert
  5. Reporter integration (detectBottlenecks)
- **BASELINE ratchet:** Violations tracked per surface; tests pass if count ≤ baseline

Sources audited (from line 45-51):
- `features/platform/outreach-dashboard/server.js` (BFF)
- `features/outreach/campaigns/sender/engine.go`
- `features/outreach/campaigns/campaign/runner.go`
- `features/outreach/relay/internal/transport/proxy_pool.go`
- `features/inbound/orchestrator/cmd/outreach/main.go`
- `features/platform/outreach-dashboard/scripts/system-report.mjs`

### heal-explanation-audit.test.js
- Validates healing action explanations for end-user clarity
- Baseline violation tracking

### harden-audit.test.js
- Enforces hardening practices across codebase

### fixture-reset.test.js
- Validates test fixture isolation and determinism

### test-quality-workflow-audit.test.js
- Workflow quality checks

### workflow-sentry.test.ts
- Sentry integration validation

---

## Contract Tests (/tests/contract/)

BFF mocked backend tests (no real Go service calls).

Key patterns:
- `vi.mock('pool')` — Mocked database pool (returns controllable results)
- `supertest(app)` — HTTP assertion library
- BFF endpoint coverage: mailboxes, templates, campaigns, replies, companies, segments, proxy, relay, cron heartbeats, fault injection

Setup file: `/tests/contract/setup.ts` (disables BFF auth via env)

Sample test structure:
- `bff-mailboxes-*.contract.test.ts` — Mailbox endpoints
- `bff-templates.contract.test.ts` — Template seed validation
- `bff-campaigns-*.contract.test.ts` — Campaign orchestration
- `bff-replies-*.contract.test.ts` — Reply forwarding, stats, Sentry hooks
- `bff-proxy-*.contract.test.ts` — Proxy pool, sources
- `bff-relay-client.contract.test.ts` — Relay integration
- `bff-cron-heartbeats.contract.test.ts` — Daemon health tracking
- `bff-fault-injection.contract.test.ts` — Chaos injection points

---

## Integration Tests (/tests/integration/)

Real PostgreSQL in-memory (pg-mem) tests.

**migration-008-integration.test.ts** (primary example)
- Seeds 3 heavy templates from migration script
- pg-mem quirks documented (lines 15-27):
  - psql meta-commands stripped
  - DO blocks stripped
  - `$BODY$` strings extracted via regex (same strategy as contract tests)
  - BEGIN/COMMIT around parameterized INSERT
- Live spintax validation (countVariations, expandSpintax, validateSpintax)
- Idempotency + UNIQUE constraint tests
- **Skip condition:** Suite skips gracefully if pg-mem unavailable (lines 64-77)

Other integration files:
- `bff-replies-integration.test.ts` — Reply flow with real DB
- `postgres-container.test.ts` — Container lifecycle
- `real-backend-smoke.test.ts` — Live Go backend smoke test

---

## Playwright E2E Tests

**Config:** `/features/platform/outreach-dashboard/playwright.config.js`
- Test dir: `./tests/e2e`
- Timeout: 30s per test
- Retries: 1 (on failure)
- Browsers: Chromium
- Base URL: `http://localhost:18175`
- Dev server: `pnpm dev` (reuse existing)
- Screenshots: only-on-failure
- Videos: off

**Run command:** `pnpm e2e` or `pnpm e2e:ui` (debug mode)

---

## Stryker Mutation Testing

**Config:** `/features/platform/outreach-dashboard/stryker.config.json`

| Key | Value |
|-----|-------|
| Test runner | vitest |
| Vitest config | `vite.config.js` (NOT vitest.config.ts — uses default scope) |
| Mutate targets | `src/lib/mailboxUtils.js` |
| Ignore patterns | `e2e/**`, `node_modules/**`, `reports/**` |
| Thresholds | high=85, low=70, break=0 |
| Coverage analysis | perTest |
| Concurrency | 4 |
| Timeout | 15000ms |
| Type checks | disabled |

**Dry-run note:** Skips tests in `test/contract/**` (via contract scope exclusion in vitest.config.ts line 49)

---

## Go Service Tests (540 total test files)

### Test Structure & Commands

```bash
# From service root
go test ./...        # All packages
go test -race ./...  # With race detection
go test -cover ./... # Coverage report
```

### Per-Service Test Counts

| Service | Test Files | Lines | Focus |
|---------|-----------|-------|-------|
| campaigns | ~100 | 9873 | Sender (1262+ tests), runner, campaign |
| mailboxes | ~60 | 656+ | DB integration, query builders |
| orchestrator | ~80 | 1500+ | IMAP, intelligence, polling |
| relay | ~70 | 1384+ | Proxy pool, transport, routing |
| inbox | ~80 | ~1000+ | Web, reply classification, threads |
| contacts | ~30 | ~400 | Contact queries |
| common | ~20 | ~150 | Shared utilities |

### Discipline Tests

**slog_op_audit_test.go** (features/outreach/campaigns/sender/)
- **Purpose:** Every slog.Error/Warn call MUST include `"op"` field as first keyed arg
- **Baseline:** 5 (initial pre-existing violations)
- **Mechanism:** AST parsing (go/parser, go/ast)
  - Scans package `.go` files (excludes `_test.go`)
  - Finds `slog.Error()` and `slog.Warn()` call sites
  - Checks for string literal `"op"` in remaining args
  - Violations logged with file:line + remediation hint
- **Ratchet:** Test fails if count > baseline; PRs lower baseline manually

Similar patterns in other services for observability enforcement.

### Test Patterns

**Table-driven tests**
```go
tests := []struct {
    name      string
    input     InputType
    want      ExpectedType
    wantErr   bool
}{
    { "case1", ..., ..., false },
    { "case2", ..., ..., true },
}
for _, tt := range tests {
    t.Run(tt.name, func(t *testing.T) { ... })
}
```

**sqlmock usage** (e.g., inbox/web/threads_test.go)
- `sqlmock.New()` — Mock database/sql connection
- `mock.ExpectQuery()` — Query expectation + rows
- `mock.AssertExpectations()` — Verify all expectations met
- Used for unit-testing DB logic without real Postgres

**Race detection**
- Run with `-race` flag in CI/local
- Detects concurrent access violations

**Functional options pattern**
- Dependency injection via constructor funcs
- Clean separation of concerns

---

## Coverage & Observability

### Frontend Coverage Metrics
- **V8 provider**, HTML + JSON + text reporters
- **Threshold enforcement:** 80% lines, functions, branches, statements
- Command: `pnpm test:coverage`

### Frontend Test Metrics (custom scripts)
| Script | Purpose |
|--------|---------|
| `test:load` | Load testing (load.mjs) |
| `test:explain` | Test explanation (explain.mjs) |
| `test:bundle` | Bundle analysis |
| `test:lighthouse` | Performance audit |
| `test:security` | Security scan |
| `test:flaky` | Flaky test quarantine |
| `test:shadow` | Shadow capture (counterfactual) |
| `test:linkage` | Production linkage validation |
| `test:density` | Assertion density analysis |
| `test:snapshot` | Production snapshot capture |
| `test:inverted-fault` | Fault inversion harness |
| `test:hallucination` | LLM hallucination detection |

### Health & Reporting
- `health` — System health JSON output
- `report` — System observability report (healing_log, daemons, bottlenecks)

---

## Key Takeaways for New Work

1. **Reuse helpers before creating new ones:**
   - SLO validation → use `slo-helpers.js`
   - Chaos/Markov → use `chaos-sim.js` (FaultInjector, MarkovSim, ShadowRunner)
   - State machines → use `state-machine.js` (StateGraph, assertions)
   - Mock fixtures → use `heal-fixtures.js` (mailbox, cron, engine)

2. **Scopes are mutually exclusive** — use TEST_SCOPE env var, not file patterns
3. **Audit tests enforce discipline** — violations tracked via baseline ratchet
4. **pg-mem for integration** — graceful skip if unavailable
5. **Go discipline:** Every slog call must have `"op"` field; baseline in test file
6. **Fast-check** for property tests (not yet observed, but framework available)
7. **Stryker on src/lib only** — not UI/network code (different signal)
