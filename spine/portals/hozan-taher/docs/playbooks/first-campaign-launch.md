# First Real Campaign Launch — General Runbook

> **Created**: 2026-04-25 (BF-G5)
> **Audience**: Operator (Tomáš + delegates).
> **Purpose**: generic gates + rollback triggers for **any** first-real-send.
> **For the specific 20-contact machinery soft launch**, see
> [LAUNCH-CAMPAIGN-001.md](LAUNCH-CAMPAIGN-001.md). This doc is the
> reusable template; that one is a fully-instantiated execution log.

## Why a separate runbook

Every first send into a fresh segment, or after a multi-week pause, is
operationally a new campaign — even if the SQL says it's "campaign 456"
of a long-lived sequence. Reputation, deliverability, and legal posture
all reset to "unproven". This runbook walks the staircase from 0 → 1 → 5
→ 20 → full deliberately so a problem catches at 1 (cheap) instead of 200
(expensive).

## Hard prerequisites — never skip

Before any send, all five must be true:

1. **Mailbox app passwords in DB** (NOT env). Verify via
   `SELECT id, from_address, status, length(password) > 0 AS has_password
   FROM outreach_mailboxes WHERE status='active'`. Operator-only step;
   Claude refuses to write passwords (memory: feedback_mailbox_passwords_via_db.md).
2. **Anti-trace-relay reachable + healthy**: `curl ${ANTI_TRACE_URL}/health`
   returns `{"status":"ok"}`. Sender refuses to start without it
   (SMTP-egress lockdown R4).
3. **Suppression UNION non-empty**: `features/platform/outreach-dashboard/campaignPreflight.js`
   gates unpause when `outreach_suppressions ∪ suppression_list` is empty.
4. **Templates have a working unsubscribe**: every template renders
   `{{.UnsubURL}}` (BF-D3 token-gated `/unsubscribe`). Visual smoke test
   on the rendered preview before any send.
5. **Operator approval recorded** in BOARD.md or audit_log. The HARD RULE
   from `feedback_campaign_send.md` is "never spustit campaign send bez
   explicitního souhlasu uživatele". This is a written record, not a
   verbal nod.

If any of the five is unclear, **stop**. Don't proceed to staircase.

## Staircase: 0 → 1 → 5 → 20 → full

Each step has the same shape: send → wait → inspect → gate. A failed
gate = stop, do not progress, investigate.

### Step 0: dry-run (no emails leave the system)

```
CAMPAIGN_DRY_RUN=true CAMPAIGN_ID=<n> pnpm send
```

- Verify slog output mentions `[dry_run]` for every recipient.
- Verify `operator_audit_log` records `campaign_tick_completed` with
  `dry_run: true`.
- Verify NO row in `send_events` for this campaign_id.

**Gate to step 1**: dry-run completes cleanly with expected recipient count
matching the contacts table (DISTINCT ON dedup confirmed).

---

### Step 1: single contact (own email or known-friendly)

```
-- Pick exactly one contact you control:
INSERT INTO outreach_contacts (email, ...) VALUES ('your-test-address@example', ...);
```

Then unpause the campaign (or run the targeted script — depends on the
specific campaign; LAUNCH-CAMPAIGN-001.md has the SQL for that one).

Within 60s, you should see:
- BFF log: `[cron] runCampaignTick duration_ms=<n>` referencing the campaign.
- Sender log: `dispatched send_event_id=<X>` with NO `error=`.
- `send_events` row inserted with `status='sent'`.
- The actual email arrives at your test address within 5 minutes.

**Gate to step 2**: email arrived, headers look clean (DKIM pass, SPF
pass, From displays correctly), unsub link works (clicking it adds your
email to suppression_list and the campaign won't include you on retry).

If headers wrong / no DKIM → stop. Fix before sending to any third party.

---

### Step 2: 5 contacts (known-friendly only)

5 contacts the operator has personal relationships with — people who will
report a problem rather than mark spam. Same monitoring as step 1, plus:
- 2/5 should reply within 24h with at least an "ack received".
- 0/5 should bounce or land in spam.
- Open tracking: at least 3/5 opens within 6h (people open business email
  during work hours).

**Gate to step 3**: 100% delivery success, 0 bounces, 0 spam complaints,
≥40% reply rate (or explicit "saw it, looks fine" via Slack/SMS).

If 1/5 bounces → stop. Investigate the address (ARES lookup, MX check)
before scaling.

---

### Step 3: 20 contacts (first real B2B segment)

This is the LAUNCH-CAMPAIGN-001.md scope. Ramp window is approximately
2 hours (avoid burst). Monitor in real-time:

- `pnpm report` every 15 min for the first 2h.
- Sentry: any `ErrAntiTrace*` or `auth_fail` → triage before next batch.
- Reply inbox: anything tagged "negative" by the LLM classifier (BF-D3) →
  manual review.

**Gate to step 4**: 24h after first send, ≥95% delivered, ≤5% bounce,
≥0.5% reply rate, no spam complaints in postmaster reports.

If bounce > 5% → bounce-throttle cron (BF-A4) auto-pauses. Don't override.

---

### Step 4: full segment (50–500 contacts)

Only after step 3 is green for at least 48h. Daily cap on each mailbox
applies — the engine will spread the send across days automatically.

Monitor:
- Daily report cron (07:00 Prague) summarizes per-mailbox stats.
- Watchdog crons (BF-A2..A5) auto-throttle on degraded health.
- LLM reply classifier (BF-D3) routes positive replies to operator review.

**Gate**: campaign continues until `outreach_contacts.status` for the
segment is no longer 'queued' for any contact.

---

## Rollback triggers

If ANY of the following fires, pause the campaign and triage before
resuming:

| Trigger | Source | Action |
|---|---|---|
| Bounce rate > 10% on any mailbox | BF-A4 cron | Cron auto-pauses; operator investigates root cause |
| 3+ consecutive AUTH failures on a mailbox | BF-E2 breaker | Mailbox enters 30m cooldown; operator may rotate password and call ResetMailboxBreaker |
| Spam complaint reported via postmaster | manual | Pause entire campaign; investigate template + sending IP rep |
| Reply classifier flags > 5% of replies as 'negative' | BF-D3 | Pause, review template wording, possibly rewrite |
| Anti-trace relay returns persistent 5xx | sender slog | Pause until relay healthy; sender refuses to send without it |
| Operator detects unintended recipient (test contact, internal address) | manual | Immediate pause, write DSR-erase entry, audit-log the incident |

## After-the-launch checklist

Within 1 week of step 4 starting:

- [ ] DSR access endpoint tested with a real recipient's email — output
      matches what we'd be willing to defend in court.
- [ ] DSR erase endpoint tested with a real recipient's email — verified
      cascade across the 5 PII tables + suppression preserved.
- [ ] Audit log retention cron (BF-D2) ran at least once after launch.
- [ ] First-week metrics summary written to BOARD.md.

## Records

| Date | Campaign | Step reached | Outcome |
|---|---|---|---|
| 2026-04-25 | runbook drafted | n/a | Initial creation |
| | | | |
