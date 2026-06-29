**Status:** Archived
**Datum:** 2026-04-25
**Trigger:** Brownfield hardening pass v3 completed (all 23 items closed 2026-04-25); work integrated into phase 0

# Brownfield Hardening Pass v3 — Service Edges + Observability + Ops Safety

> **STATUS** (2026-04-25 EOD): all 16 v3 items + all 7 v2 carry-overs **CLOSED**.
> 28 commits this pass on `feat/brownfield-hardening-2026-04-25`.
> 5403 Go tests + 2488 vitest tests green; no regressions.
> Order closed: A2, A3, A4, A5, A6, E1, E5, F5, G2, G5, F2, E6, F3, G3, G1, G4, F1, E3, E4 (covers D5), F4 (covers D6), E2.

> **Created**: 2026-04-25
> **Trigger**: User-requested follow-up after v2 closed 5/13 items (BF-A1, D1–D4)
> **Scope**: latent fragility outside the cron loop — Go service edges, observability
> consistency, and operational safety nets that v2 deliberately deferred.

## 1. Executive summary

v2 hit the BFF cron loop and the operator-facing endpoints. What's left
is the **service mesh edge** (Go services reading from each other),
the **observability fabric** (Sentry/slog consistency), and **ops
discipline** (preflight checks, secret hygiene, migration ordering)
that has accreted since the M3 carve.

Three new buckets, ranked by risk × likelihood:

| Bucket | Items | Risk |
|---|---|---|
| **BF-E — Go service edges** | 6 items: sender, antitrace, retry, discovery, audit, healing | MED-HIGH |
| **BF-F — Observability fabric** | 5 items: Sentry tag consistency, slog fields, health surfaces | MED |
| **BF-G — Ops safety nets** | 5 items: preflight, secrets, migrations, env validation, runbook | LOW-MED |

v2 carry-over (still pending): BF-A2, A3, A4, A5, A6, D5, D6 — finish before
v3 buckets unless an item is genuinely blocked.

## 2. Inventory

### Bucket E — Go service edges

E1 — `features/outreach/campaigns/sender/antitrace.go` retry classifier review
   `engine.Run` retries on transient failures. `ErrAntiTraceRateLimited`
   should back off longer than `ErrAntiTraceTransport`. Verify backoff
   table covers all 5 sentinel errors with correct delays. Add table-driven
   test for retry-class → backoff-duration mapping.

E2 — `features/outreach/campaigns/sender/engine.go` per-mailbox circuit breaker
   When a single mailbox throws 3+ AUTH failures in a row, engine should
   short-circuit further sends from that mailbox until watchdog resets.
   Currently each send re-tries → wastes proxy IPs + risks AUTH-lockout
   escalation. Half-open state on healing event.

E3 — `features/acquisition/contacts/enrichment/suppress.go` cross-schema sync
   `SuppressEmail` writes to outreach_suppressions + outreach_contacts +
   outreach_threads but NOT contacts.status. v1 fix added the SELECT-time
   filter — but stale `contacts.status='new'` rows still exist. One-time
   sweep migration + an INSERT trigger to keep them in sync going forward.

E4 — `features/outreach/mailboxes/watchdog/daemon` advisory lock TTL
   Daemon holds an advisory lock per mailbox during health-check. If
   process is OOM-killed, the lock auto-releases on conn close — BUT
   only if the conn dies. A long-idle conn can hold a stale lock. Add
   TTL-based fallback: on lock acquisition, write `locked_at` to a
   tracking row; cleanup any entry older than 10 min.

E5 — `features/inbound/orchestrator/imap/poller` UID-validity reset path
   `computeImapNewUids` handles uidValidity bumps by treating all UIDs
   as new. Verify this matches the test contract — does it write
   `last_processed_uid = max(uids)` or 0? On reset, we shouldn't replay
   already-processed messages.

E6 — `common/audit/log.go` Execer write under transaction
   `audit.Log` uses Execer — fine. But within `runner.RunCampaign`'s
   tick, does the audit write happen INSIDE the campaign-tick tx (so
   rollback would discard the audit row) or OUTSIDE (audit always
   persists)? Both have arguments. Document the choice + add test.

### Bucket F — Observability fabric

F1 — Sentry tag schema consistency
   slog calls in `features/outreach/campaigns/*` set `campaign_id`, `contact_id`,
   `mailbox`, `step`. slog calls in `features/inbound/orchestrator/*` use
   `campaign_id`, `send_event_id`, `contact_id`, `mailbox`. Verify Sentry
   processor maps both to the same tags. Otherwise grouping fragments.

F2 — Structured slog field audit
   Grep `slog.(Info|Warn|Error)` across all Go services. Every error-level
   call should have at minimum: `error`, `op` (operation name). Many
   currently lack `op`. Without it, log search by operation is broken.

F3 — Sentry release tag from build metadata
   `runtime.Version()` + commit SHA should populate Sentry `release`
   tag at boot. Currently set via env in some services, missing in
   others. Releases mismatched → dashboard can't separate v1.0 from v1.1
   error spikes.

F4 — Health-check surface gap
   `/health` endpoints across services return `ok` for DB ping. None
   currently surface anti-trace queue depth, IMAP backoff state, or
   greylist queue size. Operator dashboard polls `/health` but can't
   see these.

F5 — Cron tick observability
   Crons log start + end. They don't log duration consistently. Add
   `start_at` + `duration_ms` to every cron's `[cron] X done` line so
   we can detect slowdown trends.

### Bucket G — Ops safety nets

G1 — Deploy preflight script
   Pre-deploy checklist: env vars present, DB reachable, Railway region
   verified, schema migrations applied. Currently informal — operator
   pushes and prays. Add `scripts/deploy/preflight.sh` that gates the
   push.

G2 — Secret rotation playbook
   `OUTREACH_API_KEY`, `ANTI_TRACE_API_KEY`, `MAILBOX_PASSWORD_KEY`
   (pgcrypto), `SENTRY_AUTH_TOKEN`. No documented rotation procedure.
   Add `docs/playbooks/secret-rotation.md` with per-secret steps +
   blast-radius assessment.

G3 — Migration ordering enforcement
   `scripts/migrations/00N_*.sql` numbered but no enforcement. Operator
   could run 003 before 001. Add a `schema_migrations` table that
   records applied migrations + a runner script that refuses out-of-order.

G4 — Env-var validation at boot
   Each Go service has its own env-var unmarshalling. Some validate,
   some don't. A missing `DATABASE_URL` should crash at boot, not on
   first request. Add a shared `common/envconfig` package + per-service
   schema.

G5 — Runbook for first-real-campaign launch
   Once SEND-S1 unblocks (operator enters Seznam app passwords), the
   first campaign launch is a coordinated procedure: dry-run → 1
   contact → 5 contacts → 20 contacts. Document the gates + rollback
   triggers in `docs/playbooks/first-campaign-launch.md`.

## 3. Sprints

### v3 Sprint E — Go service edges (3 dní)

| # | Item | Effort | Owner | Notes |
|---|---|---|---|---|
| E1 | antitrace retry classifier | 2h | Claude | table-driven test |
| E2 | sender circuit breaker | 5h | Claude | new `mailbox_breaker.go` |
| E3 | contacts.status sweep | 3h | Claude | one-time migration + trigger |
| E4 | watchdog lock TTL | 3h | Claude | new `mailbox_lock_audit` table |
| E5 | IMAP uidValidity reset | 2h | Claude | extend `computeImapNewUids` test |
| E6 | audit transactional contract | 2h | Claude | doc + test |

### v3 Sprint F — Observability fabric (2 dní)

| # | Item | Effort |
|---|---|---|
| F1 | Sentry tag schema reconciliation | 3h |
| F2 | slog `op` field audit | 4h |
| F3 | Sentry release tag at boot | 2h |
| F4 | /health expanded surfaces | 4h |
| F5 | cron duration_ms field | 2h |

### v3 Sprint G — Ops safety nets (2 dní)

| # | Item | Effort |
|---|---|---|
| G1 | deploy preflight script | 4h |
| G2 | secret rotation playbook | 3h |
| G3 | migration ordering | 3h |
| G4 | env-var validation | 4h |
| G5 | first-campaign launch runbook | 3h |

### Carry-over from v2 (finish first)

| # | Item | Status |
|---|---|---|
| BF-A2 | runGreylistRetryCron worker safety | pending |
| BF-A3 | runMailboxHealthCycleCron fail-open | pending |
| BF-A4 | runMailboxBounceThrottleCron edge cases | pending |
| BF-A5 | runEmailReverifyCron rate limit | pending |
| BF-A6 | DST midnight reset audit | pending |
| BF-D5 | Advisory lock health check | pending → covers E4 |
| BF-D6 | Anti-trace-relay queue back-pressure | pending → covers F4 partially |

D5 + D6 from v2 overlap with E4/F4 in v3. Plan: do D5 inside E4
(advisory lock TTL covers both); do D6 standalone but reuse F4
expanded health-check work.

## 4. Critical path

```
v2 carry-over (A2..A6, D5→E4, D6) ─> v3 Sprint E ─> v3 Sprint F ─> v3 Sprint G
                                                  └─ Sprint G can run parallel
```

A-bucket items each need 2–4h. Doing them serially first because they
all touch crons and are easy single-PR-per-item. E2 (circuit breaker)
is the largest single piece in v3 — needs careful test coverage.

## 5. Risk register

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| RE.2 | Circuit breaker false-positives kill working mailbox | MED | HIGH | Conservative threshold (3 AUTH fails in 30 min); auto-recovery on health event |
| RE.3 | Stale contacts.status sweep affects 1000s of rows | HIGH | MED | Dry-run + chunk-size limit + audit per chunk |
| RE.4 | Lock TTL fallback freezes live tick | LOW | HIGH | TTL is 10 min, far longer than legitimate tick |
| RF.1 | Sentry tag rename breaks alerts | MED | LOW | Backwards-compatible: write both tags during transition |
| RG.3 | Migration ordering breaks existing deployments | LOW | HIGH | Backfill schema_migrations from existing DB before enforcing |
| RG.4 | Env-var crash-on-missing breaks dev workflow | MED | LOW | Default-on-missing for non-critical, fail-fast only for DB/API keys |

## 6. Definition of done

v3 is "done" when:
- [ ] Carry-over: BF-A2..A6 closed (5 items)
- [ ] Sprint E: E1–E6 closed
- [ ] Sprint F: F1–F5 closed
- [ ] Sprint G: G1–G5 closed
- [ ] No regression in 7300+ Go tests + 2400+ JS tests
- [ ] All new files have corresponding tests (≥10 cases per E/F item)
- [ ] G5 runbook reviewed by operator before merge

## 7. Out of scope

- New service additions (Office 365, Gmail mailbox providers)
- Frontend perf work beyond what's already in S6
- LLM-classifier provider expansion (Anthropic, OpenAI fallback)
- Multi-tenant DB partitioning

These are post-v3.

## 8. Schedule

Realistic pace: 2–3 commits/day per sprint. Estimate ~10 working days
for full v3. Carry-over (A2..A6) eats first 2–3 days because each cron
audit follows the same extract→test→fix pattern as A1.

```
Day 1-3:  v2 carry-over (A2..A6)
Day 4-6:  v3 Sprint E
Day 7-8:  v3 Sprint F
Day 9-10: v3 Sprint G
```
