# BFF Cron Schedule — Operator Quick Reference

> **Source**: `features/platform/outreach-dashboard/server.js` lines ~6040+ (cron scheduler block).
> **All schedules are Europe/Prague timezone unless noted.**
> **All crons stagger startup so they don't thunder-herd the DB.**

## Cron table

| Function | Frequency | Startup stagger | Purpose | Log signature |
|---|---|---|---|---|
| `getProxyPool` warm | every 5 min | +90s | Keep proxy snapshot cache warm | `[cron] proxy-pool-warm:` |
| `runFullCheckCron` | every 4h | +60s | SMTP+IMAP probe of every active mailbox | `[cron] runFullCheckCron` |
| `runImapPollCron` | every 15 min | +30s | Poll IMAP for new replies, classify, suppress | `[cron] runImapPollCron` |
| `runWarmupAdvanceCron` | daily 05:00 | scheduled | Bump warmup_day for mailboxes meeting criteria | `[cron] runWarmupAdvanceCron` |
| `runDailyReportCron` | daily 07:00 | scheduled | Email/Slack daily campaign + mailbox digest | `[cron] runDailyReportCron` |
| Midnight counter reset | daily 00:00 | scheduled | Resume mailboxes after 24h bounce cooldown | `[cron] midnight:` |
| `runMailboxHealthCycleCron` | every 30 min | +135s | Score mailboxes, auto-pause unhealthy | `[cron] runMailboxHealthCycleCron` |
| `runCampaignWatchdogCron` | every 60 min | +120s | Auto-pause campaigns with bounce > 5% | `[cron] runCampaignWatchdogCron` |
| `runBounceFlipCron` | every 15 min | +75s | Flip contacts.email_status to 'invalid' on bounce | `[cron] runBounceFlipCron` |
| `runMailboxBounceThrottleCron` | every 30 min | +85s | Cascade bounce throttle to mailbox cap reduction | `[cron] runMailboxBounceThrottleCron` |
| `runMailboxHealingCron` | every 15 min | +90s | Auto-unpause after proxy recovery | `[cron] runMailboxHealingCron` |
| `runGreylistRetryCron` | every 10 min | +100s | Retry queue for greylisted destinations | `[cron] runGreylistRetryCron` |
| `runEmailReverifyCron` | daily 03:00 | scheduled | Re-verify stale email_status entries (>90 days) | `[cron] runEmailReverifyCron` |
| `runScoringRecomputeCron` | every 60 min | +150s | Stale-first scoring batch (500/hr ≈ 12k/day) | `[cron] runScoringRecomputeCron` |
| `runEnrichmentMVRefreshCron` | every 10 min | +165s | Refresh `company_current_facts` MV (CONCURRENTLY) | `[cron] runEnrichmentMVRefreshCron` |
| Enrichment worker tick | every 30s | +180s | Process pending enrichment jobs (parsers) | `[cron] enrichment-worker:` |
| `runMailboxGreylistRetryCron` | every 30 min | +200s | Retry queue for mailbox greylist alerts | `[cron] runMailboxGreylistRetryCron` |
| `runAdaptiveRefreshCron` | every 60 min | +210s | Adaptive contact refresh based on engagement | `[cron] runAdaptiveRefreshCron` |
| `runBlacklistCheckCron` | daily 04:00 | scheduled | Check sending domains against RBLs | `[cron] runBlacklistCheckCron` |
| `runLabFeedbackLoopCron` | daily 03:00 | scheduled | KT-B5 — anonymize last N classified prod replies + APPEND into Mail Lab. Disabled unless `OPERATOR_PRACTICE_LAB_SEED_ENABLED=1`. | `[cron] runLabFeedbackLoopCron` |

## Disabled / opt-in flags

- `DISABLE_CAMPAIGN_DAEMON=1` — disables the Go-side scheduler (rarely needed)
- `BFF_IMPORT_ONLY=1` — disables ALL crons (used in unit tests)

## Manual run

Each cron function is exported via `setRouteTags` instrumentation. Operator
can trigger via SQL or shell:

```bash
# Trigger imap poll right now (bypasses 15-min schedule)
curl -X POST "$BFF_URL/api/internal/cron/imap-poll" -H "x-api-key: $OUTREACH_API_KEY"
```

(Endpoint may not exist for every cron — most run on schedule only. To
force a run, restart the BFF service which re-fires startup-staggered crons.)

## Monitoring

All cron runs log start + end + error to stdout. Railway captures these
in service logs:

```bash
railway logs --service outreach-dashboard 2>&1 | grep -E "\[cron\]" | tail -50
```

Healthy patterns:
- Each cron logs `start` and a completion summary
- Counts non-zero (else stale data)
- No `error:` lines in steady state

Alert patterns (investigate):
- `[cron] X error:` repeated → cron broken, check Sentry
- Cron silent for >2× expected interval → BFF not running or interval drifted
- `oldest_pending_age_seconds` from anti-trace-relay growing unboundedly →
  relay backlog, send pipeline stuck

## Sentry tags

Each cron sets `setRouteTags({ 'cron.action': '<name>' })` so Sentry
breadcrumbs are categorized. Filter Sentry by tag `cron.action` to see
which schedule a particular issue belongs to.

## Schedule deviation triggers

Re-evaluate this schedule when:
- Volume changes >10x (more sends → more frequent IMAP poll, faster
  bounce-flip cadence)
- Multi-mailbox pool grows (warmup advancement may need different cadence)
- New cron added (always document here)
- Operator notices a cron consistently missing its window (jitter from
  startup stagger or DB pressure)

## References

- BFF code: `features/platform/outreach-dashboard/server.js` cron scheduler block
- Greylist retry: `src/lib/automation.js` (logic), server.js (schedule)
- Watchdog: `runCampaignWatchdogCron` line ~5641
- IMAP poll (#27 fix): `runImapPollCron` line ~5247 (uses `last_processed_uid`
  watermark since 2026-04-25)
