# Dual Mailbox Pool — Decision & Operator Guide

**Status:** Active  
**Sprint:** P1 / S6.1 (2026-05-06)  
**Trigger:** Campaign 457 mailbox_pool flat list has no fallback when a mailbox score drops or circuit trips (id=3 was at score 86, below healthy threshold).

---

## Schema

Three optional JSONB arrays on `campaigns.sending_config`. All are backward-compatible — existing campaigns with only `mailbox_pool` continue to work unchanged.

| Field | Type | Purpose |
|---|---|---|
| `mailbox_pool_primary` | `int[]` | Preferred mailboxes. Used first when any are healthy. |
| `mailbox_pool_backup` | `int[]` | Emergency pool. Activated when all primary mailboxes are unhealthy. |
| `mailbox_pool` | `int[]` | Legacy flat list. Used when neither primary nor backup is configured or healthy. |

---

## Selection Logic

Implemented in `features/platform/outreach-dashboard/src/lib/campaign-send-batch.js` — `pickActivePool()`.

```
1. mailbox_pool_primary exists AND has eligible mailboxes → tier=primary
2. mailbox_pool_backup exists AND has eligible mailboxes   → tier=backup (+ audit log)
3. mailbox_pool exists AND has eligible mailboxes          → tier=legacy
4. No eligible mailboxes in any tier                       → throw NO_MAILBOXES
```

---

## Eligibility Criteria

A mailbox is eligible if ALL of the following hold (enforced in `fetchEligibleMailboxes` SQL WHERE):

| Criterion | Threshold | Rationale |
|---|---|---|
| `status` | `'active'` | Paused/inactive mailboxes excluded per H6.3 |
| `environment` | `'production'` | Test/dev mailboxes never used in production sends |
| `last_score` | `>= 80` OR NULL | Score <80 indicates delivery risk; NULL = new mailbox, treat as healthy |
| `circuit_opened_at` | IS NULL | Circuit breaker tripped — mailbox is cooling off |
| `consecutive_bounces` | `< 3` | Three consecutive bounces = systemic rejection |

Rows are ordered `last_score DESC NULLS LAST` so the healthiest mailbox is used first.

---

## When to Configure a Backup Pool

Configure `mailbox_pool_backup` when:

- Campaign volume exceeds **500 sends/day** and primary pool has ≤2 mailboxes
- One or more primary mailboxes have a **history of periodic score dips** (e.g. score oscillates 75–90)
- Campaign targets a **provider-sensitive domain** (e.g. Seznam) and primary mailboxes are all on the same IP range
- Any primary mailbox has triggered the circuit breaker in the past 30 days

---

## How to Add a Backup Pool to an Existing Campaign

```sql
-- Add primary + backup to campaign id=457, keeping existing mailbox_pool intact.
UPDATE campaigns
SET sending_config = sending_config
  || '{"mailbox_pool_primary": [1,3], "mailbox_pool_backup": [631,632]}'::jsonb
WHERE id = 457;

-- Verify
SELECT id, sending_config->'mailbox_pool_primary' AS primary,
       sending_config->'mailbox_pool_backup' AS backup,
       sending_config->'mailbox_pool' AS legacy
FROM campaigns WHERE id = 457;
```

The existing `mailbox_pool` field is preserved and serves as the last-resort fallback.

---

## Failover Audit Trail

When the backup tier activates, a row is written to `operator_audit_log`:

```
action:      campaign_pool_failover
actor:       campaign-send-batch
entity_type: campaign
entity_id:   <campaign_id>
details:     {"tier": "backup", "reason": "primary_unavailable"}
```

Query:

```sql
SELECT created_at, entity_id AS campaign_id, details
FROM operator_audit_log
WHERE action = 'campaign_pool_failover'
ORDER BY created_at DESC
LIMIT 20;
```

---

## Operator Escalation

If backup also fails (all backup mailboxes unhealthy):

1. The send batch will throw `NO_MAILBOXES` — no emails leave the system.
2. BFF returns HTTP 500 to the caller with `code: 'NO_MAILBOXES'`.
3. Check `operator_audit_log` for recent `campaign_pool_failover` and `mailbox_circuit_opened` entries.
4. Use `pnpm report` in `features/platform/outreach-dashboard` for the unified mailbox health view.
5. Either recover a primary/backup mailbox (fix score, reset circuit) OR add healthy mailbox IDs to `mailbox_pool_backup` via the SQL UPDATE above.
6. Do NOT re-enable a circuit-tripped mailbox without understanding the root cause of the bounce spike.
