# Brownfield Hardening Pass v2 — Post-S0/S6 Analysis

> **Created**: 2026-04-25
> **Trigger**: User-requested follow-up after S0–S7 sprint completion (38 commits on PR #25)
> **Scope**: latent bugs / fragility / incomplete safety nets that S0–S7 didn't surface

## 1. Executive summary

PR #25 closed the visible launch-critical gaps (compliance, reply ops,
GDPR, Cesta B, IMAP delta). What remains is **operational hardening** in
the long-tail crons, quality work in test coverage, and architecture
debt that's not blocking but accruing interest.

This pass is organized into 4 buckets, ranked by risk × likelihood:

| Bucket | Items | Risk |
|---|---|---|
| **Cron resilience** | 6 crons unaudited for fail-modes | MED-HIGH |
| **Test coverage gaps** | 6 cron paths untested | MED |
| **Architecture debt** | Schema/pool/retry policy | LOW-MED |
| **Operational** | Audit log growth, DoS surface, regex edge cases | LOW-MED |

## 2. Inventory

### Bucket A — Cron resilience

A1 — `runCampaignWatchdogCron` fail-mode audit
   What if the bounce-rate query times out mid-tick? Does the cron
   gracefully fall through or leave the campaign in a half-paused
   state? Auto-pause already wired (server.js:5187), but error-path
   not exercised under simulated DB timeout.

A2 — `runGreylistRetryCron` worker crash safety
   Processes mailbox_alerts where greylisting flagged. Race: if the
   worker crashes mid-batch, are the alerts marked retried? Should
   use SELECT FOR UPDATE + commit-per-mailbox.

A3 — `runMailboxHealthCycleCron` scoring fail-open
   Computes mailbox health score every 30 min. If one mailbox's
   score query fails, does it auto-pause the WRONG mailbox?
   (Defensive: error in scoring → leave status as-is, not auto-pause.)

A4 — `runMailboxBounceThrottleCron` cap-reduction logic
   Daily cap drops on bounce cascade. Edge case: cap already at floor,
   another bounce arrives. Does cap go negative? Does paused state
   double-fire?

A5 — `runEmailReverifyCron` rate limit on bulk re-verify
   Re-verifies stale email_status entries. If 90-day threshold has
   accumulated 50k+ stale rows, does the cron blast verifyEmail
   without rate limit? Could trip MX server abuse-detection.

A6 — Daily counter reset DST safety
   Midnight Prague time. CET → CEST transition (March + October)
   creates 23h or 25h "day". Does the reset fire at expected wall-clock
   time? Does the bounce-escalation 24h cooldown drift?

### Bucket B — Test coverage gaps

B1 — Tests for `runCampaignWatchdogCron`
B2 — Tests for `runGreylistRetryCron`
B3 — Tests for `runMailboxHealthCycleCron`
B4 — Tests for `runEmailReverifyCron`
B5 — Tests for `runAdaptiveRefreshCron`
B6 — Tests for `runBlacklistCheckCron`

Pattern: extract pure decision logic from each cron, unit-test it
in isolation (same as #27 did with computeImapNewUids).

### Bucket C — Architecture debt

C1 — Two suppression tables consolidation
   `outreach_suppressions` (Go) + `suppression_list` (JS) UNIONed at
   every read site (commits e000fb9, caba00a). Long-term: pick one as
   source of truth, migrate data, drop the other. Currently both are
   actively written by different services.

C2 — Schema A vs B join strategy
   `contacts.email_hash` JOIN `outreach_contacts.email_hash` is the
   primary cross-schema join. Index health? Query plan stability under
   million-row growth?

C3 — BFF Postgres pool sizing
   pg.Pool default = 10 connections. Under cron pressure (multiple
   crons hitting DB simultaneously) + dashboard reads, does pool
   exhaust? Default may need bumping to 25–50.

C4 — Retry strategy on transient DB errors
   ECONNRESET / EPIPE during runtime. BFF doesn't have generic
   retry-with-backoff wrapper. Each route catches its own.

### Bucket D — Operational risk

D1 — DSR access endpoint DoS surface
   `GET /api/dsr/access?email=X` runs 8 queries in parallel. No
   rate limit. If exposed (which it shouldn't be — operator-only via
   x-api-key), an attacker with the API key could cause excessive
   load. Add operator-tier rate limit + maybe Cloudflare in front.

D2 — Audit log growth
   `operator_audit_log` has no retention policy. With per-tick campaign
   audit + DSR + unsub + healing entries, table grows unboundedly.
   Add cleanup cron (e.g. delete > 5 years).

D3 — Reply classifier regex edge cases
   `\bstop\b` matches "STOP" but might miss "STOP." (trailing
   period — boundary semantics). "Unsubscribe me!" — caught.
   "Take me off your list" — NOT in regex. Czech variations like
   "vyřaďte mě" — partial coverage.

D4 — Tracking events RBAC
   `/o /c` endpoints public (necessarily). Anyone hitting `/o?t=99999`
   floods tracking_events with bogus rows. Already rate-limited (per
   server.go), but verify token-format validation rejects garbage.

D5 — Persistent advisory lock leak
   Scheduler holds advisory lock on campaign_id during tick. If
   scheduler process is killed mid-tick (Railway redeploy, OOM), is
   the lock released? Postgres advisory locks auto-release on
   connection close — but only if connection actually drops. Long-
   running idle connection holding stale lock = stuck campaign.

D6 — Anti-trace-relay envelope queue size
   `pending_envelopes` from /v1/status. If relay backlog grows beyond
   N, sender should back off (don't keep pumping into a stuck queue).
   No back-pressure currently.

## 3. Sprints

### Brownfield-v2 Sprint A — Cron resilience (5 dní)

Each item: extract decision logic into pure fn → write 5–10 tests →
fix discovered edge cases → commit. Following #27 pattern.

| # | Item | Effort | Owner |
|---|---|---|---|
| A1 | runCampaignWatchdogCron | 3h | Claude |
| A2 | runGreylistRetryCron worker safety | 4h | Claude |
| A3 | runMailboxHealthCycleCron fail-open | 3h | Claude |
| A4 | runMailboxBounceThrottleCron edge cases | 2h | Claude |
| A5 | runEmailReverifyCron rate limit | 2h | Claude |
| A6 | DST midnight reset audit | 2h | Claude |

### Brownfield-v2 Sprint B — Test coverage (3 dní)

Tests for the 6 untested crons via the extract-pure-fn pattern.

### Brownfield-v2 Sprint C — Architecture debt (1 týden, ops-coordinated)

| # | Item | Status |
|---|---|---|
| C1 | Suppression tables consolidation plan | DOC + ADR |
| C2 | Schema A/B index health audit | EXPLAIN ANALYZE on prod |
| C3 | BFF pg pool sizing | env-driven, ops-tunable |
| C4 | Retry-with-backoff wrapper | shared lib |

### Brownfield-v2 Sprint D — Operational hardening (4 dny)

| # | Item | Effort |
|---|---|---|
| D1 | DSR rate limit + audit | 2h |
| D2 | Audit log retention cron | 1h |
| D3 | Reply classifier regex expansion | 2h + property tests |
| D4 | Tracking endpoint defensive validation | 1h |
| D5 | Advisory lock health check | 3h |
| D6 | Relay queue back-pressure | 4h (sender refactor) |

## 4. Critical path

```
Sprint A (cron resilience) ─┬─> Sprint B (test coverage) ─> Sprint D (ops)
                            │
                            └─> Sprint C (arch debt) — parallel, ops-paced
```

Sprint A first because each item could be a real bug. Sprint B mostly
collateral safety after A. Sprint D smaller items shippable in parallel.
Sprint C requires ops verification.

## 5. Risk register

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| RA.1 | Sprint A reveals real bugs | HIGH | MED-HIGH | Each fix isolated, easy rollback |
| RA.2 | Bug fix breaks active production | MED | HIGH | Pure-fn extraction first, no cron change without tests |
| RB.1 | Test extraction touches cron behavior | LOW | MED | Pure functions are pure — call site behaves identically |
| RC.1 | Suppression consolidation loses opt-outs | LOW-CRIT | HIGH | Audit before merge, dry-run plan |
| RD.5 | Advisory lock leak in production | LOW | HIGH | Health check cron detects + alerts |

## 6. Definition of done

Brownfield Pass v2 is "done" when:
- [ ] Sprint A: all 6 crons have pure-fn extraction + tests + bug fixes
- [ ] Sprint B: 6 cron-test files added, all tests passing
- [ ] Sprint C: ADR-NNN-suppression-consolidation written + plan committed
- [ ] Sprint C: pg pool sized via env, default 25, max 50 docs
- [ ] Sprint D: D1-D6 individual fixes shipped + tested
- [ ] No PR-blocking regression in 2474 Go + 2400+ JS tests

## 7. Out of scope (this pass)

- New features (S6 reply triage UI improvements beyond what's done)
- Migration to multi-tenant architecture
- LLM-based reply classification (AI Act prep)
- Frontend perf optimization
- New mailbox provider integration (Office 365, Gmail)

These are post-Brownfield-v2 work, not blocking.

## 8. Schedule

Realistic working pace: 2 commits/day per sprint when ops blockers
absent. ~8 working days for full Brownfield-v2.

```
Day 1-3: Sprint A (cron resilience)
Day 4-5: Sprint B (test coverage)
Day 6-8: Sprint D (operational)
Sprint C: parallel, ops-paced (no fixed schedule)
```
