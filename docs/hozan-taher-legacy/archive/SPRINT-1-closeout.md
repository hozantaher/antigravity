# Sprint 1 close-out — 2026-04-23

**Parent:** `2026-04-23-plan-and-sprints.md`, `SPRINT-1-details.md`
**Exec window:** 2026-04-22 → 2026-04-23 (autonomous)
**Status:** CLOSED (with carryover notes for Sprint 1b)

---

## Shipped

### BE — M-prep COMPLETE (18/18 packages public) ✅

All 18 sub-packages of `modules/outreach/` now live outside `internal/`.
Internal/ retains only one orphan cross-pkg e2e_test.go. This unblocks all
subsequent web-handler carves + per-service `go.mod` creation.

| Pkg | Commit | Notes |
|-----|--------|-------|
| health    | `d17ac5d` | M5 prep |
| humanize  | `d17ac5d` | M5 prep |
| alert     | `53108ec` | M5 prep (Slack webhook) |
| imap      | `69cec7e` | M5.2a |
| thread    | `5f4e9a0` | M5.2b |
| llm       | `a1cd609` | M5 prep |
| category  | `05e72b2` | M-prep |
| ares      | `96d5c6c` batch | M-prep (3 leafs) |
| honeypot  | `96d5c6c` batch | M-prep |
| validation | `96d5c6c` batch | M-prep |
| mailsim   | `6c71694` batch | M-prep (2 pkgs) |
| seed      | `6c71694` batch | M-prep |
| sender    | `495133e` | M3.2b |
| warmup    | `5929008` batch | M3.2a (2 pkgs) |
| token     | `5929008` batch | M3.2a |
| campaign  | `f4e8491` | M3.2c (21 files) |
| protections | `96d5c6c` | M-prep (31 files) |
| db        | `fdfacfd` | M-prep (postgres + 46 migrations) |
| web       | `0e5c7b5` | M-prep (server.go + 20 files) — unblocks #120, #122 |
| intelligence + classify | `9938db8` | final — internal/ essentially empty |

**Test baseline:** 2527–2528 / 33 pkg stable every commit. Zero test loss.

### UI — Sprint 1 tickets + E2E coverage explosion ✅

**Sprint 1 tickets:**
- **#123 UI-1**: `src/lib/czech-plural.js` — 19 tests including fast-check
  property tests (500 runs over 0..10000). Banner duplicate helpers removed.
- **#124 UI-2**: T-U01 preflight gate E2E (7 disable states) + happy-path
  complement (5 enabled paths) = 12 tests total.

**New E2E pages** (previously no coverage):
- `/watchdog` — 9 tests (mailbox bar / 24h counter / events / error+retry)
- `/leads` — 12 tests (CRM with status pills + PATCH + error states)
- `/inbox` — 11 tests (reply triage + filter tabs + debounced search)
- `/replies/:id` — 10 tests (thread header + handled PATCH + graceful degradation + security lock)
- `/contacts` — 10 tests (list + search + URL filter state + error recovery)
- `/segments` — 6 tests (list + drawer + empty + create modal + stale)

**Alert banner cross-page locks** (from prior days, consolidated):
- `MissingPasswordBanner`: 6 cross-page E2E + 18 vitest (with 11-14 anomaly)
- `AuthFailAlertBanner`: 12 cross-page E2E + 13 vitest + Czech pluralization lock
- `ProxyExhaustBanner`: 5 E2E (triggered / absent / truncation / scope)

**SEND-S2 #100 full feature** shipped over 3 commits:
- BFF `POST /api/mailboxes/:id/auth-reset` + auth-fail-alerts query filter
- UI drawer button (visible when `auth_fail_count>0` OR `circuit_opened_at`)
- 12 contract + 6 E2E endpoint + 5 drawer button tests
- Runbook updated (`AUTH-FAIL-ALERT-RESPONSE.md` step 5)

**Total new tests this sprint-arc:** ≈120 E2E + vitest + contract cases.

---

## Deferred to Sprint 1b

### #120 M3.3 + #122 M5.3 web handler carves

Both require Server struct dependency-injection refactor (`outreach/web.Server`
is coupled to `db`, `health`, `dnsResolver`, `mux` via unexported fields).
Clean carve needs:

1. Export accessor methods `Server.DB()`, `Server.Health()` OR
2. Extract a `Deps` struct per handler cluster (cleaner but bigger diff)

**Recommendation:** Do option 2 in Sprint 1b — a single 2h block dedicated
to Server struct decoupling. Produces features/outreach/campaigns/internal/web +
features/inbound/inbox/internal/web with thin handler fns that take Deps.

### #121 M5.2c reply classification slice

Blocked on #122 (inbox/web carve). Will land Sprint 1b alongside #122.

---

## Sprint 2 kickoff posture

Sprint 2 (2026-04-30 → 2026-05-06) goal: `features/outreach/campaigns/go.mod` + `features/inbound/inbox/go.mod`. With 18 pkgs public and Sprint 1b carves landing early, the go.mod work is then purely mechanical (follow `features/outreach/mailboxes` M1d pattern).

**Prerequisite complete:** Go internal/ visibility no longer blocks any path in the repo.

---

## Telemetry

- Commits on `wm/development`: ~25 over the sprint-arc, all pushed
- Test baseline held: 2527 Go tests / 33 pkg every step
- Go build clean every commit
- No CI regressions (local runs — Railway CI is user-gated #66)
- Memory files updated: quality debt summary, M-prep progress

---

## References

- Master plan: `2026-04-23-plan-and-sprints.md`
- Ticket detail: `SPRINT-1-details.md`
- Migration plans: `services/{campaigns,inbox}/MIGRATION-M{3,5}.md`
- BOARD: `docs/handoff/BOARD.md` (synced 2026-04-23)
