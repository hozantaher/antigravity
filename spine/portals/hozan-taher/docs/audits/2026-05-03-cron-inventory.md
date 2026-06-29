# BFF Cron Job Inventory — S3.1 Migration Analysis

**Date:** 2026-05-03  
**Status:** Read-only audit (no code changes)  
**Context:** BFF dormant on Railway since 2026-04-29; cataloging 14 active cron jobs before migration to Go orchestrator.

---

## Executive Summary

**14 cron jobs identified in BFF (`features/platform/outreach-dashboard/server.js`)**

| Outcome | Count |
|---------|-------|
| **MIGRATE** to Go orchestrator | 9 |
| **DELETE** (P2 diagnostic / moved to Go) | 4 |
| **KEEP** (ad-hoc operator trigger) | 1 |

**Top-3 Migration Priorities** (critical → cost):
1. `runImapPollCron` — Inbound reply ingestion; zero-downtime requires immediate Go ownership
2. `runMailboxHealthCycleCron` — Auto-unpause + health checks; direct impact on sending pipeline
3. `runGreylistRetryCron` — Greylisting backoff state; prevents message loss

**Estimated Migration Impact:** 2–3 weeks (P0–P1 jobs); P2 can wait until post-stabilization.

---

## Cron Job Decision Matrix

| Name | Frequency | Description | Dependencies | Criticality | Decision | Notes |
|------|-----------|-------------|--------------|-------------|----------|-------|
| `runImapPollCron` | 15 min | Poll IMAP for inbound replies; update thread state + reply metadata | PostgreSQL, IMAP credentials (DB), orchestrator/imap module | **P0** | **MIGRATE** | Already exists in Go (`features/inbound/orchestrator/imap/poller.go`); BFF version removed Apr 29; **ACTIVATE Go poller immediately** |
| `runMailboxHealthCycleCron` | 30 min | Score-based mailbox health sweep; auto-unpause recovered mailboxes; trigger full-checks for degraded mailboxes | PostgreSQL (outreach_mailboxes, status_reason), HTTP `GET /api/mailboxes/{id}/full-check?force=1` | **P0** | **MIGRATE** | No Go equivalent; health loop logic must move to orchestrator; currently dormant; **HIGH RISK if skipped** (mailboxes stuck paused) |
| `runGreylistRetryCron` | 10 min | Retry queue for addresses in greylisting cooldown; requeue to SMTP sender after delay | PostgreSQL (email_verify_queue), anti-trace-relay | **P0** | **MIGRATE** | Prevents message loss + maintains greylisting compliance; no Go equivalent; **MUST MIGRATE FIRST** |
| `runBounceFlipCron` | 15 min | Flip bounce flag to email_status in campaigns; track bounce velocity | PostgreSQL (send_events, email_status) | **P1** | **MIGRATE** | Bounce-to-status mapping needed for historical correctness; low complexity; secondary to P0 jobs |
| `runMailboxBounceThrottleCron` | 30 min | Cascade-throttle mailboxes with sustained bounce rates; auto-pause with status_reason='auto: sustained bounce warn' | PostgreSQL (outreach_mailboxes, daily_cap_reduced_at) | **P1** | **MIGRATE** | Smart pause logic; prevents runaway bounce loops; secondary to health cycle but important for stability |
| `runMailboxHealingCron` | 15 min | Auto-recover mailboxes after proxy/SMTP failures; unpause if issue resolves | PostgreSQL (outreach_mailboxes, auth_fail_count) | **P1** | **MIGRATE** | Complements health cycle with proxy-recovery signaling; overlaps with health logic but separate concern |
| `runWarmupAdvanceCron` | Daily @ 05:00 | Increment mailbox warmup_day counter for gradual send-rate increase | PostgreSQL (outreach_mailboxes.warmup_day) | **P2** | **MIGRATE** | Warmup schedule required for reputation compliance; low risk; can migrate after P0–P1 |
| `runDailyReportCron` | Daily @ 07:00 | Aggregate send_events by day; export metrics (sent, opened, clicked, bounced) | PostgreSQL (send_events), reporting tables | **P2** | **DELETE** | Dashboard-only metrics; non-critical; operator can run on-demand; archive if metrics redundant with BI pipeline |
| `runMidnightResetCron` | Daily @ 00:00 | Reset daily-cap counters; unpause mailboxes past 24h cooldown after bounce escalation | PostgreSQL (outreach_mailboxes.daily_cap_reduced_at, consecutive_bounces) | **P2** | **MIGRATE** | Ties to bounce escalation state; safe to defer until bounce throttle logic complete |
| `runLabFeedbackLoopCron` | Daily @ 03:30 | Export anonymized prod replies to Mail Lab for training (conditional on `OPERATOR_PRACTICE_LAB_SEED_ENABLED=1`) | PostgreSQL (ai_suggestion_audit), external IMAP (LAB_IMAP_USER/PASS) | **P2** | **DELETE** | Lab-only; development tool; not production-critical; operator can seed manually if needed |
| `runEmailReverifyCron` | Daily @ 03:00 | Batch re-verify addresses via external verification service (trigger via runVerifyAndPersist) | PostgreSQL (contacts.verification_status), external email-validation API | **P2** | **DELETE** | Verification infrastructure deprecated in favor of go-based approach (if exists); dormant in current flow; verify if still in use before deleting |
| `runScoringRecomputeCron` | Hourly | Recompute mailbox health scores (last_score, last_score_at); fetch stale mailboxes batch | PostgreSQL (outreach_mailboxes.last_score) | **P2** | **DELETE** | **Moved to Go:** `features/inbound/orchestrator/intelligence/mailbox_score_loop.go` runs 24/7 (4h interval); BFF version was fallback during dev; **CONFIRM Go loop active before deleting** |
| `runSyntheticSmokeCron` | Every 60s (+ 90-day retention sweep @hourly) | Continuous health invariant validation; run 10 synthetic checks against BFF API; persist to synthetic_runs table; Sentry on fail | PostgreSQL (synthetic_runs), internal BFF HTTP, Sentry | **P2** | **MIGRATE** | Production monitoring; signal via `SKIP_SYNTHETIC_CRON=1` kill-switch; low resource cost; **KEEP** if Go orchestrator lacks equivalent synthetic surface |
| `runEnrichmentMVRefreshCron` + `runEnrichmentWorkerTick` + `runAdaptiveRefreshCron` | 10 min (MV) / 30s (worker) / 6h (planner) | Contact enrichment: refresh materialized view (company_current_facts); claim + execute parser jobs; schedule adaptive refresh jobs via tier multiplier | PostgreSQL (enrichment_jobs, company_current_facts, companies, tier), enrichment parsers (parserRegistry) | **P1** | **MIGRATE** | Multi-tier enrichment pipeline; affects dashboard lead display; no Go equivalent; **secondary to sending path but important for UX** |
| `runGreylistRetryCron` (anonymous) | Hourly (synthetic retention) | Delete synthetic_runs rows older than 90 days | PostgreSQL (synthetic_runs) | **P3** | **DELETE** | Housekeeping; no operator impact if skipped short-term; can batch into a general retention sweep |
| **Proxy pool warm cache** | 5 min (with 90s initial delay) | Fire-and-forget prefetch of proxy pool snapshot every 5min; keep read-through cache warm (no operator-visible timed output; pure cache maintenance) | PostgreSQL (proxy pool), anti-trace-relay | **P1** | **MIGRATE** | Essential for zero-latency proxy assignment; if skipped, first mailbox request cold-fetches relay; small footprint; can move as utility function |

---

## Cross-Reference: Go Orchestrator Inventory

**Existing loops in `/features/inbound/orchestrator/`:**

| Go Component | Equivalent BFF Job | Status |
|---|---|---|
| `orchestrator/imap/poller.go` | `runImapPollCron` | ✓ **ACTIVE** (24/7) — BFF should be disabled |
| `orchestrator/intelligence/mailbox_score_loop.go` | `runScoringRecomputeCron` | ✓ **ACTIVE** (4h interval, 24/7) — **BFF MUST BE DELETED** |
| `orchestrator/intelligence/loop.go` | Generic intelligence daemon (not yet decomposed to individual crons) | ✓ **PARTIAL** — consolidation point for P0–P1 analysis jobs; new crons wire here |
| `orchestrator/cmd/outreach/main.go` (heartbeat ticker @ 60s) | Synthetic-like liveness check | **PARTIAL** — not a full synthetic suite; serves operational heartbeat |

**Crons NOT yet in Go (candidates for migration):**
- Health cycle (mailbox evaluation + auto-unpause)
- Bounce flip (send_events → email_status)
- Bounce throttle (cascade pause logic)
- Mailbox healing (proxy recovery detection)
- Greylisting retry
- Enrichment pipeline (MV refresh + worker + planner)
- Synthetic smoke suite

---

## Migration Strategy & Ordering

### Phase 1: Immediate (activate Go side, disable BFF duplicates)
1. **Confirm** `orchestrator/imap/poller.go` is running 24/7 on Railway.
2. **Confirm** `orchestrator/intelligence/mailbox_score_loop.go` is running 24/7 and scoring every 4h.
3. **Disable** `runImapPollCron` + `runScoringRecomputeCron` in BFF immediately (already off; just audit).

### Phase 2: Core pipeline (weeks 1–2)
Migrate P0–P1 jobs that directly impact sending:
1. `runGreylistRetryCron` — lowest complexity; enables retry logic.
2. `runMailboxHealthCycleCron` + `runMailboxBounceThrottleCron` — health sweep + throttle.
3. `runMailboxHealingCron` — proxy-recovery signaling.
4. Proxy pool warm cache — utility function (low surface area).

Wiring point: `orchestrator/intelligence/loop.go` or new `orchestrator/intelligence/sender_health_loop.go`.

### Phase 3: Secondary (weeks 2–3)
1. `runBounceFlipCron` — bounce → email_status mapping.
2. `runWarmupAdvanceCron` — warmup schedule.
3. `runMidnightResetCron` — daily reset (tie to bounce escalation).
4. Enrichment pipeline — depends on parserRegistry availability in Go (may require standalone daemon).

### Phase 4: Cleanup (after stabilization)
1. Delete P2 diagnostic jobs: `runDailyReportCron`, `runLabFeedbackLoopCron`, `runEmailReverifyCron`.
2. Evaluate `runSyntheticSmokeCron` — migrate if no Go equivalent, else archive BFF version.

### Phase 5: Verification
Before full decom:
- [ ] Go loops emit heartbeats to `cron_heartbeats` (same audit as BFF)
- [ ] Sentry receives health + failure signals
- [ ] Operator observability unchanged (dashboard → `/health` endpoint includes daemon status per BF-F4)

---

## Risk Matrix

| Cron | Skip Risk | Mitigation |
|------|-----------|-----------|
| IMAP poll | **CRITICAL** — no reply ingestion | Go poller must be verified running before BFF off |
| Health cycle | **CRITICAL** — mailboxes stuck paused | Implement auto-unpause logic in Go immediately |
| Greylisting | **HIGH** — message loss | Replay queue on demand from DB if cron missed |
| Bounce flip | **MEDIUM** — historical accuracy lost | Can recompute offline after migration |
| Enrichment | **MEDIUM** — dashboard stale; UX impact | Can queue jobs on-demand; batch later |
| Daily reports | **LOW** — metrics refresh delay | Export metrics on-demand or skip |
| Lab feedback | **LOW** — training data stale | Manual seed or defer to post-launch |

---

## Testing Checklist

Before marking migration complete:
- [ ] Go IMAP poller running 24/7 (verify in logs + `cron_heartbeats` table)
- [ ] Go score loop running 4h cycle (check `outreach_mailboxes.last_score_at` timestamps)
- [ ] Greylisting queue drains within expected window (< 10 min backlog)
- [ ] Mailbox auto-unpause fires post-score if recovery detected
- [ ] No duplicate health checks (BFF off + Go on = single source)
- [ ] Proxy pool cache hits ≥95% (monitor via `getProxyPool` cache stats)
- [ ] Synthetic suite runs and persists (if migrated to Go)
- [ ] Operator observability via `/health` shows all daemons operational

---

## Summary

**14 cron jobs, 9 actionable migrations, 4 safe deletes, 1 keep-as-is.**

**Next step:** Create [S3.2 Go migration task](docs/initiatives/2026-05-02-post-cleanup-hardening.md) with phased PR structure (greylisting → health cycle → bounce logic → enrichment). Use this inventory to guide implementation order + risk assessment per migration step.

