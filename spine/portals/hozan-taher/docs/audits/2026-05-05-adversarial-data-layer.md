---
Status: Active
Date: 2026-05-05
Trigger: Authorized adversarial red-team — data layer + suppression mechanism
Scope: scripts/migrations/*, features/outreach/campaigns/sender/dedup_guard.go, features/platform/outreach-dashboard/src/server-routes/dsr.js, features/inbound/orchestrator/intelligence/loop.go, features/outreach/campaigns/campaign/runner.go
---

# Adversarial Data Layer Sweep — 2026-05-05

## Summary

8 attack vectors probed. Findings: 3 CRITICAL, 3 HIGH, 2 MEDIUM, 1 LOW.

CRITICAL findings are fixed inline in this PR via migration 052 and a runner.go patch.

---

## F1 — CRITICAL: Suppression bypass via unsuppress + stale campaign_contacts

**Vector:** contact suppressed via UI, then unsuppressed via `DELETE /api/suppression/:email`

**Repro:**
```
1. Contact enrolled in active campaign (campaign_contacts.status = 'pending').
2. Operator adds email to suppression_list (via POST /api/suppression).
   → migration 048 trigger fires: contacts.status = 'suppressed'.
3. Operator removes the suppression (DELETE /api/suppression/foo@bar.com).
   → Row deleted from suppression_list. NO reverting trigger exists.
   → contacts.status stays 'suppressed'.
4. Runner tick:
   - c.status NOT IN ('bounced','blacklisted','invalid','unsubscribed',
     'opted_out','human_handoff','paused_human','completed_no_reply',
     'retention_expired') → 'suppressed' is NOT in this list → PASSES.
   - suppressionFilter UNION: email not in suppression_list, not in
     outreach_suppressions → PASSES.
   - Contact is sent to.
```

**Root cause:** `runner.go` status NOT IN list does not include `'suppressed'`
(file `features/outreach/campaigns/campaign/runner.go` line ~175). The design intent
was that `suppressionFilter` is the last-line gate, but that gate only looks
at real-time table content. An unsuppressed contact leaves a gap where status
= 'suppressed' but the email is not in either suppression table.

**Fix:** Added `'suppressed'` to the runner.go NOT IN list. Applied in this PR.

**Also note:** The same gap applies when a row is removed from
`outreach_suppressions` directly via `psql` (no BFF endpoint for this, but
operator-level DB access could do it). Adding 'suppressed' to NOT IN closes
both paths.

---

## F2 — CRITICAL: Status constraint violation silently dropped on reply classification

**Vector:** reply classifier writes `contacted.status = 'replied_negative'`,
`'replied_positive'`, or `'auto_reply'` but these values are not in the
`contacts_status_check` constraint.

**File:** `features/platform/outreach-dashboard/server.js` lines 4282–4286:
```js
await pool.query(`UPDATE contacts SET status='replied_negative' WHERE id=$1`, [d.contactId]).catch(() => {})
await pool.query(`UPDATE contacts SET status='replied_positive' WHERE id=$1`, [d.contactId]).catch(() => {})
await pool.query(`UPDATE contacts SET status='auto_reply' WHERE id=$1`, [d.contactId]).catch(() => {})
```

**Constraint (migration 051):** allows only `valid | bounced | blacklisted |
invalid | unsubscribed | suppressed | replied`.

`replied_negative`, `replied_positive`, `auto_reply` are NOT in the constraint.

**Impact:** PostgreSQL raises a CHECK constraint violation (error 23514).
The `.catch(() => {})` swallows it silently. The contact retains whatever status
it had before the reply (typically `valid`). Result:

- The contact is not blocked by `c.status NOT IN` in runner.go.
- Enrollment still passes (c.status = 'valid').
- Suppression for negative replies happens correctly (suppression_list INSERT
  is a separate path that succeeds), but if that suppression is later removed,
  the contact has no status-level signal.
- Observability: the classification happened but the DB record is wrong with
  no error surfaced.

**Fix:** Migration 052 extends `contacts_status_check` to include
`replied_negative`, `replied_positive`, `auto_reply`. Applied in this PR.

---

## F3 — CRITICAL: GDPR Art. 17 cascade gap — crm_clients table not erased

**Vector:** DSR erase (`POST /api/dsr/erase`) does not touch `crm_clients`.

**File:** `features/platform/outreach-dashboard/src/server-routes/dsr.js` — the erase
transaction deletes from: `tracking_events`, `reply_inbox`, `send_events`,
`outreach_contacts`, `contacts`. It also cascades `channel_audit_log` and
anonymizes `ai_suggestion_audit`. `crm_clients` is absent.

**Migration 050 (`050_crm_clients_import.sql`)** added `crm_clients` with
columns `email_primary`, `email_secondary`, `name`, `ico`, `phone_primary`,
`phone_secondary` — all PII under GDPR Art. 4.

A data subject exercising Art. 17 erasure would have their `contacts` row
deleted but their CRM record (potentially containing a different email,
phone, name, company) would persist indefinitely.

The Art. 30 ROPA (`docs/legal/art30-register.md`) must be updated to include
`crm_clients` as a processing activity with retention period.

**Fix:** Migration 052 does not add a cascade for crm_clients because the
operator's legal team needs to confirm whether CRM records are kept for
legitimate-interest or contract-performance purposes (Art. 6(1)(b) —
existing client relationship). A GH issue is filed instead. The DSR
_access_ endpoint should also be updated to include crm_clients data, but
that is in-scope for the access response not the erase (pending legal input).

**Severity:** CRITICAL — GDPR compliance gap, potential fine exposure.

---

## F4 — HIGH: Trigger gap — unsuppress does not revert contacts.status

**Vector:** `DELETE /api/suppression/:email` removes the suppression_list row
but no trigger exists to revert `contacts.status` to a prior value.

**Root cause:** Migration 048 adds `AFTER INSERT` trigger on `suppression_list`.
No `AFTER DELETE` trigger exists.

**Impact:** After unsuppress, `contacts.status = 'suppressed'` permanently
(until manually corrected). The contact cannot be re-enrolled because
`enrollContacts` requires `c.status = 'valid'`. This is the *safe* failure
mode (blocks too much rather than too little), but it creates an operator
trap: after a "test suppression" the contact appears in reports with
status='suppressed' and cannot be enrolled in new campaigns without a
manual `UPDATE contacts SET status='valid'` — an operation with no UI.

**Also applies** to `outreach_suppressions` (migration 005 trigger). If
an operator directly DELETEs from `outreach_suppressions` via psql, the same
one-way status flip occurs.

**Fix recommendation:** Add `AFTER DELETE` trigger on both `suppression_list`
and `outreach_suppressions` that sets `contacts.status = 'valid'` WHERE
`status = 'suppressed'` AND the email is not in the OTHER suppression table.
Migration 052 does not implement this — the reverting trigger requires a
business decision on what status to restore (valid vs. pre-suppression value
which is not stored). GH issue filed.

---

## F5 — HIGH: Audit log retention conflict — Go pruner (90d) vs. BFF (1825d)

**Vector:** Two independent pruning loops run against the same
`operator_audit_log` table with different retention horizons.

**BFF** (`features/platform/outreach-dashboard/server.js` line 5076): configurable via
`AUDIT_LOG_RETENTION_DAYS`, defaults to 1825 days (5 years).

**Orchestrator** (`features/inbound/orchestrator/intelligence/loop.go` line 327):
hardcoded `INTERVAL '90 days'`, runs every 6h, no env override.

**Impact:** If both services point to the same database, the orchestrator
deletes logs older than 90 days that the BFF would have kept for 5 years.
GDPR Art. 30 requires records of processing to be maintained; deleting the
operator_audit_log at 90 days destroys the accountability trail including
DSR access logs, migration audit rows, and campaign action records.

**Repro SQL:**
```sql
SELECT MIN(created_at) FROM operator_audit_log;
-- Run 6h later after orchestrator tick:
SELECT MIN(created_at) FROM operator_audit_log;
-- Logs older than 90 days gone.
```

**Fix:** The orchestrator pruner should read `AUDIT_LOG_RETENTION_DAYS`
(same env var as BFF, default 1825) instead of hardcoding 90 days. Applied
in this PR to `features/inbound/orchestrator/intelligence/loop.go`.

---

## F6 — HIGH: Suppression bypass via email case/whitespace normalization — partial

**Vectors tested:**

| Pattern | Risk |
|---------|------|
| `FOO@BAR.COM` vs `foo@bar.com` | SAFE — both tables normalized via `lower(trim(email))` |
| `  foo@bar.com  ` (leading/trailing whitespace) | SAFE — `trim()` in both tables and filter |
| `.foo@bar.com` vs `foo@bar.com` (leading dot) | MEDIUM — distinct emails per RFC 5321; no alias collapse. Low real-world risk for CZ B2B targets. |
| `foo+marketing@bar.com` vs `foo@bar.com` | NOT NORMALIZED — these are treated as distinct emails. An operator who manually adds `foo@bar.com` to suppression_list would not suppress `foo+marketing@bar.com` if that's the address in contacts. |
| IDN homograph (`аpple.com` Cyrillic а vs `apple.com` Latin a) | NOT PROTECTED — `lower(trim())` does not normalize Unicode scripts. In practice CZ B2B contacts use ASCII domains, risk is near-zero. |
| Unicode normalization (NFC vs NFD, `é` U+00E9 vs `e` + combining accent) | NOT PROTECTED — same as IDN. PostgreSQL text equality is byte-by-byte. CZ B2B risk negligible. |

**Plus-addressing bypass** is the only practically relevant gap: the system
stores whatever email the contact import pipeline provides. If the import
keeps `foo+segment@company.cz` as-is, a suppression on `foo@company.cz`
would not block it. Current import pipeline does not strip plus-suffixes.

**Fix recommendation (MEDIUM priority):** Add a `lower(split_part(email, '+', 1)) || '@' || split_part(email, '@', 2)` normalization pass at import time, or add a
`email_canonical` generated column. GH issue filed. Not in this PR's scope.

---

## F7 — MEDIUM: Dedup guard TOCTOU — cross-campaign parallel runners

**Vector:** Two campaigns run concurrently (different advisory locks). Both
contain the same contact. `CheckEligibility` reads `lifetime_touches` at T0
before either send completes.

**Repro:**
```
T=0: Campaign A runner calls CheckEligibility(contact_id=X): lifetime_touches=2, limit=3 → passes.
T=0: Campaign B runner calls CheckEligibility(contact_id=X): lifetime_touches=2, limit=3 → passes.
T=1: Campaign A enqueues and sends → trigger: lifetime_touches = 3.
T=2: Campaign B enqueues and sends → trigger: lifetime_touches = 4.
```

**Impact:** Contact receives one extra send beyond the configured limit
(3 in this window → actual: 4+). The cross-campaign cooldown axis in
`CheckEligibility` queries `send_events.sent_at` — same race, but the
window is 90 days so pre-existing sends (not in-flight) are still detected.

**Severity MEDIUM** because:
1. The advisory lock per campaign_id prevents intra-campaign double-send.
2. The lifetime_touches limit still bounds future sends after the race.
3. CZ B2B context: concurrent campaign runs for the same contact are rare
   (contacts are typically in one campaign at a time via segment exclusivity).

**Fix options:** (a) Use `SELECT ... FOR UPDATE` on the contact row before
checking — blocks other runners. (b) Use a separate advisory lock per
contact_id for the check+enqueue window. GH issue filed.

---

## F8 — LOW: Migration numbering gap 028–046 not in repo

**Observation:** `scripts/migrations/` jumps from `027_voice_profiles.sql`
to `047_email_lower_indexes.sql` (predecessor note in 047: `046_manual_reply_outbox`).
Migrations 028–046 were applied to production but their SQL files are absent
from this repository.

**References found:** `docs/playbooks/BFF-SELF-HEALING-SPRINTS.md` mentions
`040_bff_boot_log.sql`, `041_proxy_blacklist.sql`.
`docs/playbooks/FIRST-CAMPAIGN-SPRINTS.md` mentions `044_leads.sql`,
`045_campaign_enrollments_email_hash.sql`.

**Impact:** Drift detection in `scripts/migrations/run.sh` (sha256 mismatch
check) cannot validate these migrations. The `schema_migrations` table
should have rows for them (applied via `099_schema_migrations_compat.sql`
backfill) but content_sha256 = 'manual-backfill' for pre-BF-G3 rows,
meaning drift detection is disabled for them.

**Severity LOW** because the migrations were already applied successfully to
production and are not blocking anything now.

**Recommendation:** Reconstruct the SQL files (if available in git history
of other branches/forks) or document them as deliberately archived. The
`_archive/` directory is the right place.

---

## Migration 028–046 gap — schema_migrations verification query

To confirm all applied migrations are tracked:
```sql
-- Run against prod DB to find any schema_migrations rows with manual-backfill sha:
SELECT migration_id, filename, applied_at
FROM schema_migrations
WHERE content_sha256 = 'manual-backfill'
ORDER BY migration_id;
```

---

## DSR cascade table inventory (post-audit)

| Table | Art.17 action | In current cascade |
|-------|---------------|-------------------|
| contacts | DELETE | YES |
| outreach_contacts | DELETE | YES |
| send_events | DELETE | YES |
| reply_inbox | DELETE | YES |
| tracking_events | DELETE | YES |
| outreach_threads | UPDATE status='closed' | YES (as designed) |
| channel_audit_log | DELETE | YES |
| ai_suggestion_audit | ANONYMIZE | YES |
| suppression_list | INSERT (keep as proof) | YES |
| outreach_suppressions | INSERT (keep as proof) | YES (with catch) |
| **crm_clients** | **MISSING** | **NO — F3 above** |
| anonymity_test_messages | N/A — operator mailboxes, not subject emails | N/A |
| operator_audit_log | N/A — legal accountability record, Art. 30 | N/A |

---

## Fixes Applied in This PR

| Fix | File | Type |
|-----|------|------|
| Add 'suppressed' to runner.go NOT IN list (F1) | `features/outreach/campaigns/campaign/runner.go` | Code |
| Extend contacts_status_check constraint (F2) | `scripts/migrations/052_contacts_status_constraint_v2.sql` | Migration |
| Orchestrator audit log retention configurable (F5) | `features/inbound/orchestrator/intelligence/loop.go` | Code |

## GH Issues Filed

| Finding | Severity |
|---------|----------|
| F3 — crm_clients missing from Art. 17 DSR cascade | CRITICAL |
| F4 — Unsuppress does not revert contacts.status | HIGH |
| F6 — Plus-addressing bypass in suppression | MEDIUM |
| F7 — Dedup guard TOCTOU cross-campaign | MEDIUM |
