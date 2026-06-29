# Sprint 1 — FINAL CLOSE-OUT (2026-04-23)

**Parent:** `2026-04-23-plan-and-sprints.md`, `SPRINT-1-details.md`, `SPRINT-1-closeout.md`
**Status:** ALL 5 TICKETS DELIVERED. Sprint 2 unblocked.

---

## Sprint 1 — final scoreboard

| # | Ticket | Status | Commits |
|---|--------|--------|---------|
| #120 | M3.3 carve /api/campaigns/* + /api/segments/* | ✅ | `e0535d0`, `0541c92` |
| #121 | M5.2c reply classification slice → features/inbound/inbox/reply | ✅ | `6142273`, `f387fd2` |
| #122 | M5.3 carve /api/replies/:id/reply → features/inbound/inbox/web | ✅ | `0a8c3f6` |
| #123 | UI-1 Czech pluralization helpers + property tests | ✅ | `e06d55c` |
| #124 | UI-2 T-U01 preflight gate E2E lock | ✅ | `05e72b2`, `2a9c762` |

---

## Architectural milestones achieved

### M-prep COMPLETE (18/18 packages)

`modules/outreach/internal/` directory **REMOVED**. Every Go sub-package is
publicly importable. Commits across ~15 mechanical promotes preserving
2527-test baseline at every step.

### Cross-module web carves working

- `features/outreach/campaigns/web/` — handlers for /api/campaigns + /api/segments
- `features/inbound/inbox/web/` — handler for /api/replies/:id/reply
- `features/inbound/inbox/reply/` — domain wrapper over outreach/llm

Pattern proved: handlers placed at `services/<domain>/web/` (public, NOT
internal/web/) so `outreach/web` can import them. Thin Server-receiver
adapters in `outreach/web/{campaigns,segments,threads}.go` preserve all
21+ legacy tests zero-modification.

### Per-service go.mod

- `features/outreach/campaigns/go.mod` — module campaigns, registered in go.work
- `features/inbound/inbox/go.mod` — module inbox, registered in go.work
- `services/{campaigns,inbox}/go.sum` — pulled DATA-DOG/go-sqlmock for tests

---

## Test totals (this sprint-arc)

### Backend (Go)
| Module | Tests |
|--------|------:|
| `modules/outreach/` (all 33 pkgs) | 2527 |
| `features/inbound/inbox/` | 35 (20 reply + 15 web) |
| `features/outreach/campaigns/` | 45 (15 unit + 30 property/fuzz) |
| `features/outreach/mailboxes/` | (unchanged) |
| `features/acquisition/contacts/` | (unchanged) |
| **Total Go growth this sprint** | **+80** |

### Frontend (vitest + Playwright)
- New E2E specs: `/watchdog` (9), `/leads` (12), `/inbox` (11),
  `/replies/:id` (10), `/contacts` (10), `/segments` (6), `/campaigns/:id`
  preflight gate (12), auth-reset drawer (5), auth-reset endpoint (6),
  M3.3+M5.3 carve smoke (11), MissingPasswordBanner cross-page (6),
  AuthFailAlertBanner cross-page (12), ProxyExhaustBanner (5)
- New vitest: czech-plural lib (19), AuthFailAlertBanner pluralization (4),
  MissingPasswordBanner pluralization (6)
- **Total UI growth this sprint: ~140 tests**

### Property/fuzz
- czech-plural: fast-check 500 runs over 0..10000
- campaignsweb: testing/quick 500+200+300+200 random inputs over name,
  min_score, category_match
- reply.Normalize: testing/quick 500×3 properties (idempotent, total fn,
  enum-only)
- Path fuzz: 10 path shapes × 2 methods on HandleCampaignDetail

---

## Sprint 2 posture

**Goal:** SEND pilot live — first real campaign #1.

**Prerequisites met:** ✅
- All web handler carves working (M3.3, M5.3 done early in Sprint 1b)
- services/{campaigns,inbox}/go.mod with deps resolved
- internal/ visibility no longer blocks anything
- E2E + property test patterns established for new packages

**Unblocked tickets ready for Sprint 2:**
- #99 SEND-S1 — user delivers Seznam credentials
- #101 SEND-S3 — E2E self-send (script + endpoint already exist)
- #103 SEND-S5 — first pilot campaign
- #84 M2 relay reorganization
- #88 M6 dashboard shell cleanup
- #89 M7 modules/outreach/ smazání

**Open items deferred to Sprint 2:**
- CampaignNew wizard E2E (modal selectors need deeper debug; skipped for
  this sprint to keep scope tight)
- /api/categories handler carve (small, optional Sprint 2 fast-follow)

---

## Cross-branch signals (for Chat B)

**Resolved this sprint:**
- `Resolves-Trailer: Needs-Tests: features/outreach/campaigns/web` → 45 cases
- `Resolves-Trailer: Needs-Tests: features/inbound/inbox/web` → 10 cases
- `Resolves-Trailer: Needs-Tests: features/inbound/inbox/reply` → 15 cases

**New A → B signals:**
- `Needs-Tests: features/outreach/campaigns/web HandleSegments coverage parity` —
  campaigns_test.go covers HandleCampaigns + HandleCampaignDetail; segments
  helpers untested at unit level (only via legacy adapter route).

---

## References

- Master plan: `2026-04-23-plan-and-sprints.md`
- Ticket details: `SPRINT-1-details.md`
- First close-out (mid-sprint): `SPRINT-1-closeout.md`
- Migration plans: `services/{campaigns,inbox}/MIGRATION-M{3,5}.md`
- BOARD: `docs/handoff/BOARD.md`
