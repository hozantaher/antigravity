# MVP Campaign 1 Launch — Day 1 Observation Log

**Launch Date:** 2026-05-05  
**Monitoring Window:** 07:00–2026-05-06 07:00 (24h)  
**Cohort Size:** 7 envelopes  
**Daily Mail Cap:** 5/day/mailbox × 4 active = 20/hour max  
**Operator:** _______________  

---

## Pre-Launch State (06:55)

**Queue Depth (runner):**  
- Expected: 0–2 pending
- Actual: ________________

**Relay Pool Active Status:**  
- Mullvad peer active: ________________
- Last health check (Ochrany): ________________
- Pool reputation score: ________________

**Last Sanity Sweep:**  
- Timestamp: ________________
- Bypass violations found: ________________
- Mailbox circuit_opened count: ________________

**Verify-Launch Checklist (5/5):**  
- [ ] Campaign `status='paused'` confirmed
- [ ] Day-1 sendlist loaded (7 recipients)
- [ ] All 4 mailboxes auth_fail_count = 0
- [ ] Relay circuit_opened_at all NULL
- [ ] suppress_until expiry checked (none stale)

**Notes:** _______________________________________________________________

---

## T0 Unpause (07:00)

**Campaign Status Flip:**  
- Command issued: ________________
- Status changed to: `running`
- First runner tick log line:  
  `2026-05-05T07:00:XX.XXXZ slog[op=campaigns.sender/EnqueueAndRun] campaign_id=1 phase=day_1 ...`

**Initial State Verified:**  
- All 4 mailboxes SMTP reachable: ________________
- Relay endpoint responding: ________________

**Notes:** _______________________________________________________________

---

## T+15m (07:15) — First Seal & IMAP Receipt Check

**Sealed Envelope Status:**  
```sql
SELECT count(*) AS sealed_count, max(sealed_at) 
FROM send_events WHERE campaign_id=1 AND status='sealed' AND sealed_at > now() - interval '30 minutes';
```
- Expected: 1–3 sealed
- Actual: ________________

**External IMAP Receipt Verification:**  
- Test inbox 1 (Gmail/external): First inbound email received? ________________
  - If YES: Timestamp ________________ (compare to sealed_at − should be <5m)
  - If NO: Check relay logs for delivery error
- Test inbox 2: ________________
- Test inbox 3: ________________

**Relay Queue Status:**  
- Queue depth (redis): ________________
- Oldest pending age (seconds): ________________

**Observations:** _______________________________________________________________

---

## T+1h (08:00) — Hourly Delivery Checkpoint

**Delivery Progress Query:**  
```sql
SELECT 
  count(*) FILTER (WHERE status='sent') AS total_sent,
  count(*) FILTER (WHERE status='bounced') AS total_bounced,
  count(*) FILTER (WHERE status='sealed') AS still_sealed,
  count(*) FILTER (WHERE status='failed') AS failed
FROM send_events WHERE campaign_id=1;
```

| Metric | Expected Range | Actual |
|--------|---|---|
| Total Sent | 3–7 | ________________ |
| Bounced | 0 | ________________ |
| Still Sealed | 0–2 | ________________ |
| Failed | 0 | ________________ |

**Per-Mailbox Progress:**  
```sql
SELECT id, smtp_username, last_score, circuit_opened_at, auth_fail_count, daily_sent_today
FROM outreach_mailboxes WHERE status='active' ORDER BY id;
```

| Mailbox ID | Last Score | Circuit Open? | Auth Fails | Daily Sent |
|---|---|---|---|---|
| 1 | ______ | ______ | ______ | ______ |
| 2 | ______ | ______ | ______ | ______ |
| 3 | ______ | ______ | ______ | ______ |
| 4 | ______ | ______ | ______ | ______ |

**Queue Trajectory:**  
- Depth at 08:00: ________________
- Trend (rising/stable/draining): ________________

**Sentry Alert Check:**  
- New errors in last hour: ________________
- Top error (if any): ________________

**Decision Point:**  
- [ ] Continue normal rate
- [ ] Notes: ___________________________________________________________

---

## T+4h (11:00) — Half-Day Escalation Checkpoint

**Delivery Rate %:**  
```sql
SELECT 
  round(100.0 * count(*) FILTER (WHERE status='sent') / 
    NULLIF(count(*), 0), 1) AS delivery_pct
FROM send_events WHERE campaign_id=1;
```
- Expected: ≥70% (5+ of 7 sent)
- Actual: ________________%

**Mailbox Health Summary:**  
- Any circuit_opened_at populated? ________________
- Auth failure spike? ________________
- Reputation score trend: ________________

**IMAP Inbound Classification (replies/auto-responses):**  
```sql
SELECT classification, count(*) FROM imap_messages 
WHERE thread_id IN (SELECT id FROM threads WHERE campaign_id=1)
AND received_at > now() - interval '4 hours'
GROUP BY classification;
```
- Expected: 0–1 replies/auto-responses (low cohort)
- Actual: ________________

**Escalation Decision (choose one):**  
- [ ] **CONTINUE** — All metrics nominal, proceed to Day-2 rate (30/day) tomorrow
- [ ] **HOLD** — Rate stable but low INBOX %, observe next 4h before Day-2 ramp
- [ ] **ROLLBACK** — Critical issue detected, see notes below

**Decision Rationale & Notes:**  
_______________________________________________________________  
_______________________________________________________________

---

## T+8h (15:00) — Afternoon Health Check

**Cumulative Send Stats:**  
```sql
SELECT 
  status, count(*) AS ct 
FROM send_events WHERE campaign_id=1
GROUP BY status ORDER BY ct DESC;
```

| Status | Count |
|---|---|
| sent | ________________ |
| bounced | ________________ |
| sealed | ________________ |
| failed | ________________ |
| (other) | ________________ |

**Relay Queue Age:**  
```sql
SELECT min(enqueued_at) AS oldest_pending, count(*) FROM relay_queue_events 
WHERE status='pending' AND campaign_id=1;
```
- Oldest pending age (seconds): ________________
- Alert threshold: >1800s (30m) = investigate

**Mailbox Reputation Delta (since 08:00):**  
- Any scores dropped >5 points? ________________
- Any new circuit opens? ________________

**Spam Classification Rate:**  
```sql
SELECT round(100.0 * count(*) FILTER (WHERE classification='spam_flag') / 
  NULLIF(count(*), 0), 1) AS spam_pct
FROM imap_messages WHERE thread_id IN 
  (SELECT id FROM threads WHERE campaign_id=1)
AND received_at > now() - interval '8 hours';
```
- Expected: <5%
- Actual: ________________%

**Operator Observation:**  
_______________________________________________________________

---

## T+12h (19:00) — End-of-Day Delivery Report

**Final Day-1 Cumulative Results:**  
```sql
SELECT 
  count(*) FILTER (WHERE status='sent') AS final_sent,
  count(*) FILTER (WHERE status='bounced') AS final_bounced,
  count(*) FILTER (WHERE status='failed') AS final_failed,
  round(100.0 * count(*) FILTER (WHERE status='sent') / NULLIF(count(*), 0), 1) AS inbox_rate_pct
FROM send_events WHERE campaign_id=1;
```

| Metric | Value |
|---|---|
| Total Sent | ________________ |
| Total Bounced | ________________ |
| Total Failed | ________________ |
| INBOX Rate % | ________________ |

**Per-Mailbox Final Stats:**  
```sql
SELECT id, smtp_username, daily_sent_today, last_score, circuit_opened_at 
FROM outreach_mailboxes WHERE status='active' ORDER BY id;
```

| Mailbox | Daily Sent | Final Score | Circuit Open? |
|---|---|---|---|
| 1 | ______ | ______ | ______ |
| 2 | ______ | ______ | ______ |
| 3 | ______ | ______ | ______ |
| 4 | ______ | ______ | ______ |

**Reply Ingestion Summary (since 07:00):**  
- Total inbound replies/OOO: ________________
- Classification confidence: ________________
- Any parsing errors? ________________

**Sentry Error Summary:**  
- Total errors (24h): ________________
- Critical/high-sev count: ________________
- Patterns: ________________

**End-of-Day Notes:**  
_______________________________________________________________  
_______________________________________________________________

---

## T+24h (2026-05-06 07:00) — Day 1 Closeout & Day-2 Decision

**Final Cohort Metrics:**

| KPI | Target | Actual |
|---|---|---|
| Delivery Rate | ≥70% | ________________% |
| Bounce Rate | <5% | ________________% |
| Spam/Block Rate | <10% | ________________% |
| Mailbox Circuit Opens | 0 | ________________ |
| IMAP Inbound Errors | 0 | ________________ |
| Relay Queue Drain Time | <4h | ________________h |

**Mullvad Pool Health (24h aggregate):**  
- Peer rotation count: ________________
- Zero ok_count occurrences: ________________ (expected rare)
- Reputation trend: ________________

**Day-2 Rate Decision (choose one):**  
- [ ] **SCALE UP** — All KPIs nominal; proceed to 30/day/mailbox (150/day total)
  - Action: Campaign status → `rate_level=2` in runner config
  - Scheduled start: 2026-05-06 07:00
  
- [ ] **HOLD AT CURRENT** — Performance acceptable but need more data
  - Extend Day-1 rate for 12–24h more
  - Re-assess at T+36h
  
- [ ] **PAUSE & INVESTIGATE** — Issues detected requiring fix
  - Issue: _______________________________________________________________
  - Investigation plan: _______________________________________________________________
  - Est. resume: ________________

**Operator Sign-Off:**

| Field | Value |
|---|---|
| Operator Name | ________________ |
| Operator Email | ________________ |
| Final Status | ☐ Nominal | ☐ Degraded | ☐ Blocked |
| Approval | ☐ Day-2 approved | ☐ On hold | ☐ Escalated to Tomáš |

**Final Observations & Handoff Notes:**  
_______________________________________________________________  
_______________________________________________________________  
_______________________________________________________________

---

## Rollback Playbook (if triggered)

If escalation decision = **ROLLBACK**, execute:

1. **Pause Campaign Immediately**  
   ```bash
   psql $DATABASE_URL -c "UPDATE campaigns SET status='paused' WHERE id=1;"
   ```

2. **Drain Relay Queue**  
   ```bash
   psql $DATABASE_URL -c "DELETE FROM relay_queue_events WHERE campaign_id=1 AND status='pending';"
   ```

3. **Verify No Lingering Sends**  
   ```bash
   psql $DATABASE_URL -c "SELECT count(*) FROM send_events WHERE campaign_id=1 AND status='sealed';"
   ```

4. **Document Incident**  
   - Root cause: _______________________________________________________________
   - Duration (first sign → pause): ________________
   - Recipients affected: ________________
   - Remediation: _______________________________________________________________

5. **Notify Tomáš**  
   - Slack / Email: Provide this log excerpt + escalation details
   - Next launch date: ________________ (after issue fix + re-test)

---

**Template Version:** 2026-05-05  
**Last Updated:** Pre-launch (operator: fill during 24h window)
