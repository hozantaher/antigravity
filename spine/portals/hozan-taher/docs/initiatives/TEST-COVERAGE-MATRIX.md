# Test Coverage Matrix — 2026-04-23 (end of Sprint 1 + partial Sprint 2)

**Purpose:** Snapshot the Go + UI test landscape after the Sprint 1 arc so
Chat B can pick the next coverage gap without hunting.

---

## Backend (Go)

### modules/outreach/ (main module)

| Pkg                       | Tests | Coverage notes                              |
|---------------------------|------:|---------------------------------------------|
| alert                     |     n | webhook signing + payload shape locked      |
| ares                      |     n | API client wrapper                          |
| audit                     |     n | audit log writer                            |
| calendar                  |     n | send-window time math                       |
| campaign                  |   187 | state machine + preflight + runner          |
| category                  |     n | category tree store                         |
| classify                  |     n | ICP/NACE/sector/region                      |
| config                    |     n | config loader                               |
| content                   |     n | template rendering                          |
| db                        |     n | pool + migrations                           |
| e2etest                   |    19 | full pipeline cross-pkg                     |
| exclusion                 |     n | suppression list                            |
| health                    |     n | health registry                             |
| honeypot                  |     n | honeypot traps                              |
| humanize                  |     n | tone/circadian/fingerprint                  |
| imap                      |     n | IMAP poller                                 |
| intelligence              |     n | cross-domain loop                           |
| llm                       |     n | Anthropic client + classify                 |
| mailsim                   |     n | SMTP test harness                           |
| metrics                   |     n | prom                                        |
| protections               |     n | L3 probes                                   |
| seed                      |     n | prodlike fixtures                           |
| sender                    |   397 | SMTP engine + circuit breaker               |
| thread                    |     n | thread resolver + merging                   |
| token                     |     n | message token replacement                   |
| validation                |     n | input validation                            |
| warmup                    |     n | ramp plan + daily cap                       |
| web                       |     n | /api/campaigns /segments adapters + shared  |

**Total:** 2527 Go tests / 33 packages stable.

### services/ (per-service modules)

| Module               | Tests | Notes                                         |
|----------------------|------:|-----------------------------------------------|
| features/outreach/campaigns/  |    65 | web pkg (15 unit + 30 property/fuzz + 20 segments) |
| features/inbound/inbox/      |    35 | reply 15 + web 10 + property laws             |
| features/acquisition/contacts/   |   374 | enrichment/contact/prospect/segment + 14 web  |
| features/outreach/mailboxes/  |   n/a | M1 tests distributed                          |
| features/outreach/relay/      |   n/a | 33-pkg relay module, own test suite           |
| features/compliance/privacy-gateway/ | n/a | (not exercised in this sprint)            |

### Property/fuzz coverage

| Pkg                        | Pattern              | Runs  |
|----------------------------|----------------------|------:|
| features/outreach/campaigns/web     | quick.Check on name/min_score/category_match | 1000+ |
| features/outreach/campaigns/web     | body/path fuzz       | 14+10 |
| features/inbound/inbox/reply       | Normalize laws       | 1500  |
| features/inbound/inbox/reply       | enum consistency     | const |

---

## Frontend (vitest + Playwright)

### vitest (unit/component)

| Suite                           | Tests | Location                                       |
|---------------------------------|------:|------------------------------------------------|
| czech-plural                    |    19 | src/lib/czech-plural.test.js                   |
| MissingPasswordBanner           |    18 | src/components/MissingPasswordBanner.test.jsx  |
| AuthFailAlertBanner             |    13 | src/components/AuthFailAlertBanner.test.jsx    |
| ProxyExhaustBanner              |    n  | src/components/ProxyExhaustBanner.test.jsx     |
| Dashboard.watchdog              |    n  | src/pages/Dashboard.watchdog.test.jsx          |
| ThreadDetail                    |    n  | src/pages/ThreadDetail.test.jsx                |
| Campaigns (page)                |    n  | src/pages/CampaignDetail.test.jsx              |
| Mailboxes.components            |    n  | src/pages/Mailboxes.components.test.jsx        |
| Mailboxes.missing-password-badge|    n  | src/pages/__tests__/...                         |
| Segments                        |    n  | src/pages/Segments.test.jsx                    |
| Companies.drawer                |    n  | src/pages/Companies.drawer.test.jsx            |
| Inbox                           |    n  | src/pages/Inbox.test.jsx                       |
| Analytics.components            |    n  | src/pages/Analytics.components.test.jsx        |

### Contract tests (BFF vitest)

| Suite                             | Tests | Location |
|-----------------------------------|------:|----------|
| bff-mailboxes (inventory + routes) |   126 | test/contract/bff-mailboxes.contract.test.ts |
| bff-mailboxes-extended             |     n | ... -extended.contract.test.ts |
| bff-mailboxes-has-valid-password   |     n | ... -has-valid-password.contract.test.ts |
| bff-segments                       |    13 | test/contract/bff-segments.contract.test.ts |
| bff-campaigns-preflight            |     n | test/contract/bff-campaigns-preflight.contract.test.ts |
| bff-categories                     |    15 | test/contract/bff-categories.contract.test.ts (NEW) |
| bff-auth-fail-alerts               |     n | test/contract/bff-auth-fail-alerts.contract.test.ts |
| bff-e2e-failure                    |     n | test/contract/bff-e2e-failure.contract.test.ts |
| bff-fault-injection                |     n | test/contract/bff-fault-injection.contract.test.ts |
| bff-property-fuzz                  |     n | test/contract/bff-property-fuzz.contract.test.ts |
| api-response-envelope              |     n | test/contract/api-response-envelope.contract.test.ts |
| api-route-inventory (snapshot)     |    29 | test/contract/api-route-inventory.snapshot.test.ts |
| auth-matrix                        |     n | test/contract/auth-matrix.test.ts |
| input-fuzzing                      |     n | test/contract/input-fuzzing.test.ts |
| structural-invariants              |     n | test/contract/structural-invariants.test.ts |

### Playwright E2E (34+ specs)

| Page / flow                         | Tests | Notes                                  |
|-------------------------------------|------:|----------------------------------------|
| /mailboxes (overview / CRUD / drawer / search / badge) | 5+ | existing pre-sprint |
| /campaigns (happy path + preflight) |   12+5 | Sprint 1                               |
| /campaigns/:id (detail)             |     n | existing                               |
| /campaign-lifecycle                 |     n | existing                               |
| /replies (list)                     |     n | existing                               |
| /replies/:id (ThreadDetail)         |    10 | Sprint 1 new                           |
| /inbox                              |    11 | Sprint 1 new                           |
| /watchdog                           |     9 | Sprint 1 new                           |
| /leads                              |    12 | Sprint 1 new                           |
| /contacts                           |    10 | Sprint 1 new                           |
| /segments                           |     6 | Sprint 1 new                           |
| /templates                          |     n | existing                               |
| /analytics                          |     n | existing                               |
| /healing-dashboard                  |     n | existing                               |
| /scoring                            |     n | existing                               |
| /dashboard                          |     n | existing                               |
| /jobs-flow                          |     n | existing                               |
| /navigation                         |     n | existing                               |
| /visual (regression)                |   18  | existing                               |
| /a11y                               |     n | existing                               |
| /console-errors                     |     n | existing                               |
| /companies                          |     n | existing                               |
| MissingPasswordBanner               |     4+6 | pages + cross-page                   |
| AuthFailAlertBanner                 |    3+12 | base + cross-page                     |
| ProxyExhaustBanner                  |     5 | Sprint 1 new                           |
| auth-reset-endpoint                 |     6 | Sprint 1 new                           |
| auth-reset-drawer-button            |     5 | Sprint 1 new                           |
| send-pipeline-health                |     n | pre-sprint                             |
| missing-password-banner (badge)     |     n | pre-sprint                             |
| M3.3+M5.3 carve smoke               |    11 | Sprint 1 new                           |

---

## Known gaps (next sprint targets)

### BE

- `HandleSegments` list happy-path test — currently only DB-error locked (#segments_test.go:40)
- `features/outreach/campaigns/web/segments_test.go TestHandleSegmentDetail_GetNotFound` accepts 500 (segment.Store.Get wraps ErrNoRows). Consider strict 404 contract check.
- Relay module internal/ reorganization (M2.2-5, Sprint 2 week)
- Intelligence loop — no property tests yet

### UI

- CampaignNew wizard E2E — modal selector debug pending (deferred)
- /scoring expansion (has skeleton, could add property-based axis weight tests)
- /templates editor flow (basic coverage exists)
- Bulk contact import flow (exists but shallow)

### Contract

- `/api/campaigns/:id/run` + `/pause` — no BFF contract test
- `/api/campaigns/:id/capacity` — exists via preflight but not isolated

---

## How to use this matrix

- `n` means "test file exists but test count not yet enumerated here"
- Counts with concrete numbers (e.g., 15, 397) are verified via
  `go test -count=1 <path>` or `pnpm vitest run <pattern>`
- Update this doc once per sprint as ground-truth inventory

## References

- `docs/initiatives/SPRINT-1-FINAL.md` — Sprint 1 close-out
- `docs/initiatives/2026-04-23-plan-and-sprints.md` — 5-sprint master
- `docs/handoff/BOARD.md` — cross-chat sync
