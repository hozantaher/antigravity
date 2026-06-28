# Mailbox Creation — Operator Runbook

> **Created**: 2026-05-09 (AQ5)
> **Audience**: Operator (Tomáš + delegates).
> **Purpose**: Step-by-step lifecycle for registering a new seznam.cz mailbox + DB insertion + smoke test.
> **Context**: Post-Goran-disaster (2026-05-09 auth_lock both nowak.gorak + goran.nowak). Remediation for issue #1121.

## Overview

This runbook walks the operator through:
1. Pre-flight checks (capacity, personality alignment, Mullvad pool state)
2. seznam.cz signup (IP geolocation, account profile, password hygiene)
3. DB insertion (idempotent SQL, schema fields, daily cap defaults)
4. Mullvad endpoint pinning (unique SOCKS5 exit assignment per mailbox)
5. Smoke test (full-check endpoint — verify SMTP/IMAP auth)
6. Lifecycle phase ramp (5 → 10 → 25 → 50 → 100 sends/day over 30 days)

## Hard prerequisites

Before proceeding, **all three must be true**:

- **Mullvad wgpool health**: `curl -s $ANTI_TRACE_RELAY_URL/v1/proxy-pool | jq '.cz_prg_available'` shows ≥1 available CZ-Prague endpoint.
- **Personality record exists**: A corresponding row in `operator_settings` (or `personas`, if using legacy structure) with `brand_label`, first name, last name, signature.
- **Operator signed off**: Write a comment in the issue or BOARD.md before signup. Do not proceed on verbal permission.

If any is unclear, **stop**.

---

## 1. Pre-flight

### 1.1 Decide: single or batch signup?

Check today's warmup cap budget:

```bash
# How many d0 (5 sends/day) slots do we need?
# Rule: never > total_capacity / 5 concurrent warmup mailboxes.
# Example: 500 contact/day target, 5 per mailbox = max 100 mailboxes.
# If adding 1: OK. If adding 10: discuss with Tomáš first.

psql "$DATABASE_URL" -c "
  SELECT COUNT(*) as active_count,
         SUM(CASE WHEN lifecycle_phase='warmup_d0' THEN 1 ELSE 0 END) as in_d0
  FROM outreach_mailboxes WHERE status='active';
"
```

### 1.2 Personality alignment check

Verify the persona name, display name, and brand label match the campaign context:

```bash
# Example: Goran Nowak → nowak.goran@email.seznam.cz
# Signature: "Goran Nowak\nBalkan Motors d.o.o."
# Brand: "Balkan Motors"

psql "$DATABASE_URL" -c "
  SELECT id, brand_label, first_name, last_name, signature
  FROM operator_settings
  WHERE brand_label = 'Balkan Motors';
"
# Record: first_name='Goran', last_name='Nowak' → username will be nowak.goran
```

### 1.3 Mullvad endpoint quota

Check available CZ-Prague exits:

```bash
curl -s "$ANTI_TRACE_RELAY_URL/v1/proxy-pool" | jq '.endpoints | map(select(.label | startswith("cz-prg-wg-"))) | length'
```

Must be ≥1 free endpoint. If all are pinned, coordinate a re-pin with Tomáš (see memory: `project_egress_canonical`).

---

## 2. seznam.cz Signup

### 2.1 VPN setup — CZ IP REQUIRED

**CRITICAL**: Signup from non-CZ IP = fraud flag from seznam.cz fraud gate. All 4 Goran mailboxes were auth_locked after multi-country logins in 30 min.

```bash
# Option A: Use CZ-based VPN (Mullvad CZ)
mullvad relay set location Czech\ Republic

# Option B: Operator in Prague — native IP
curl https://ipinfo.io/json | jq '.country'  # Must show 'CZ'

# Verify IP before browser signup
```

### 2.2 Open https://email.seznam.cz/registrace in browser

**Do NOT reuse cookies from personal seznam login.** Use **private/incognito mode**.

### 2.3 Signup form

| Field | Value | Notes |
|-------|-------|-------|
| **Username** | `<persona.lastname>.<persona.firstname>` | E.g. `nowak.goran` (lowercase, no spaces) |
| **Password** | Random 12+ chars, unique | `$(openssl rand -base64 12 \| head -c 16)` — **NOT your personal pwd** |
| **Confirm email** | Auto-filled | seznam sends confirm link to signup email; retrieve from browser |
| **Phone (optional)** | Skip | Not required; adds attack surface |
| **Recovery email** | Skip | Email is sufficient; recovery email = drift risk |
| **Account name display** | Full persona name | E.g. "Goran Nowak" (for From: header) |

### 2.4 Verify & activate

- Check email for seznam verification link.
- Click link in same browser session (CZ IP).
- Do **NOT** click from a different country or device.
- Account status → "Active".

### 2.5 Profile settings (CRITICAL for anti-trace)

**Timezone**:
```
Settings → Account → Time zone → Europe/Prague
```
**Why**: Send timestamps must align with Prague timezone. If operator/server is in UTC, schedule jobs to emit Prague-local times for anonymity.

**Language**: Czech (cs-CZ) — default.

### 2.6 Close browser & reset VPN

```bash
# Once signup complete
mullvad relay set location off  # Reset to default
# Or restart mullvad
systemctl restart mullvad
```

**Do NOT** open webmail or login again from non-CZ IP. The account is now live on seznam servers.

---

## 3. DB Insertion

### 3.1 Prepare variables (BASH — local shell only, redact in final paste)

```bash
# These are TEMPLATE variables. Fill in YOUR values locally.
# NEVER paste password inline into shared doc or chat.

FROM_ADDRESS="nowak.goran@email.seznam.cz"
DISPLAY_NAME="Goran Nowak"
PASSWORD="$(openssl rand -base64 12 | head -c 16)"  # Generated from browser signup
PREFERRED_COUNTRY="CZ"
PINNED_ENDPOINT="cz-prg-wg-001"  # Assign below in step 3.2

echo "DB INSERT will use:"
echo "  from_address=$FROM_ADDRESS"
echo "  display_name=$DISPLAY_NAME"
echo "  password=***$(echo -n "$PASSWORD" | tail -c 4)  # redacted"
echo "  pinned_endpoint=$PINNED_ENDPOINT"
```

### 3.2 Find an available CZ endpoint

Query unused pinned endpoints:

```bash
psql "$DATABASE_URL" -c "
  SELECT DISTINCT pinned_endpoint_label
  FROM outreach_mailboxes
  WHERE pinned_endpoint_label IS NOT NULL
    AND pinned_endpoint_label LIKE 'cz-prg-wg-%'
  ORDER BY pinned_endpoint_label;
" > /tmp/used.txt

# From relay proxy pool, pick the lowest available number not in /tmp/used.txt
# Example: used = [cz-prg-wg-001, cz-prg-wg-002] → pick cz-prg-wg-003
```

Assign via variable:
```bash
PINNED_ENDPOINT="cz-prg-wg-003"
```

### 3.3 Insert row (idempotent)

**CRITICAL**: Use `psql -v password=...` variable substitution (memory: `feedback_no_pii_in_commands`). **Never inline password.**

```bash
psql "$DATABASE_URL" \
  -v password="$PASSWORD" \
  -c "
INSERT INTO outreach_mailboxes (
  from_address, display_name, smtp_host, smtp_port, smtp_username,
  imap_host, imap_port, imap_username, password,
  tz, locale, lifecycle_phase, preferred_country,
  status, environment, daily_cap_override,
  pinned_endpoint_label, pinned_endpoint_by
) VALUES (
  '$FROM_ADDRESS',
  '$DISPLAY_NAME',
  'smtp.seznam.cz', 465, '$FROM_ADDRESS',
  'imap.seznam.cz', 993, '$FROM_ADDRESS',
  :'password',
  'Europe/Prague', 'cs-CZ', 'warmup_d0', 'CZ',
  'active', 'production',
  5,
  '$PINNED_ENDPOINT', 'operator'
)
ON CONFLICT (from_address) DO NOTHING
RETURNING id, from_address, lifecycle_phase, daily_cap_override;
"
```

**Expected output**: One row with `id=NNN, from_address=nowak.goran@email.seznam.cz, lifecycle_phase=warmup_d0, daily_cap_override=5`.

**Why `daily_cap_override=5`?**
See memory: `project_tocfg_daily_limit_zero`. Go code computes daily cap from `lifecycle_phase` (returns 5 for `warmup_d0`), but there is a silent bug in old ToConfig parsing where a missing `daily_cap_override` is treated as 0 → cap is 0 → all sends rejected. Set it explicitly to 5 to guard against the bug.

### 3.4 Verify insert

```bash
psql "$DATABASE_URL" -c "
  SELECT id, from_address, smtp_username, lifecycle_phase,
         daily_cap_override, pinned_endpoint_label, status, created_at
  FROM outreach_mailboxes
  WHERE from_address = 'nowak.goran@email.seznam.cz';
"
```

All fields must be populated. `created_at` auto-sets to NOW().

---

## 4. Mullvad Endpoint Pinning

### 4.1 Update pinning (if not done in 3.3)

If you inserted without `pinned_endpoint_label`, update it now:

```bash
MAILBOX_ID="42"  # From previous query
PINNED_ENDPOINT="cz-prg-wg-003"

psql "$DATABASE_URL" \
  -c "
UPDATE outreach_mailboxes
   SET pinned_endpoint_label = '$PINNED_ENDPOINT',
       pinned_endpoint_at = NOW(),
       pinned_endpoint_by = 'operator'
 WHERE id = $MAILBOX_ID
 RETURNING id, pinned_endpoint_label, pinned_endpoint_at;
"
```

### 4.2 Verify uniqueness

```bash
psql "$DATABASE_URL" -c "
  SELECT pinned_endpoint_label, count(*) as mailbox_count
  FROM outreach_mailboxes
  WHERE pinned_endpoint_label IS NOT NULL
    AND status = 'active'
  GROUP BY pinned_endpoint_label
  HAVING count(*) > 1;
" 
```

**Expected**: Empty result set (no duplicate assignments).

If duplicates exist, the unique constraint in migration 084 will catch it. Resolve by re-pinning stale mailboxes to unused endpoints.

---

## 5. Smoke Test

### 5.1 Call full-check endpoint

```bash
MAILBOX_ID="42"

curl -s \
  -H "X-API-Key: $OUTREACH_API_KEY" \
  "http://localhost:3000/api/mailboxes/$MAILBOX_ID/full-check" \
  | jq '.'
```

### 5.2 Check response

**Expected**:
```json
{
  "id": 42,
  "from_address": "nowak.goran@email.seznam.cz",
  "score": 85,  // ≥80 is healthy
  "smtp_auth_ok": true,
  "imap_auth_ok": true,
  "proxy_ok": true,
  "circuit_status": "closed",
  "auth_failures_7d": 0
}
```

**If `score < 80`**: Check Sentry for auth failures:
- `auth_locked` → seznam fraud flag (restart needed, contact seznam support).
- `imap_auth_failed` → Wrong password or app-password issue (update in DB).
- `smtp_auth_failed` → Same as IMAP.
- `circuit_opened` → Too many auth failures; endpoint is quarantined (wait 1h, retry).

### 5.3 Resume on failure

If smoke test fails, **do not proceed to campaigns**. Diagnose:

```bash
# Check Sentry for mailbox errors
# https://sentry.io/organizations/hozan-taher/projects/

# Check auth logs
psql "$DATABASE_URL" -c "
  SELECT id, mailbox_used, error_reason, failed_at
  FROM mailbox_auth_fails
  WHERE mailbox_used = 'nowak.goran@email.seznam.cz'
  ORDER BY failed_at DESC
  LIMIT 10;
"
```

Common fixes:
- **Password mismatch**: Verify password in seznam webmail login. If wrong, reset via seznam "Forgot password" → update DB INSERT → retry.
- **IP geolocation error**: seznam sees non-CZ source IP for first SMTP/IMAP connect. Restart Mullvad to a CZ endpoint → retry full-check.
- **Circuit open**: Wait 60 minutes (circuit breaker TTL) → retry.

---

## 6. Lifecycle Phase & Warmup Ramp

### 6.1 Understand phases

| Phase | Days | Sends/day | Auto-advance trigger |
|-------|------|-----------|----------------------|
| `warmup_d0` | 0–2 | 5 | `created_at + 3 days` |
| `warmup_d3` | 3–6 | 10 | `created_at + 7 days` |
| `warmup_d7` | 7–13 | 25 | `created_at + 14 days` |
| `warmup_d14` | 14–29 | 50 | `created_at + 30 days` |
| `production` | 30+ | 100 | (no auto-advance beyond) |

Phases are enforced by `trg_enforce_warmup_cap` trigger on `send_events` INSERT.

### 6.2 Manual phase override (if needed)

If mailbox is older than its current phase (e.g., created 40 days ago but still in `warmup_d0`), manually advance:

```bash
psql "$DATABASE_URL" -c "
UPDATE outreach_mailboxes
   SET lifecycle_phase = 'production'
 WHERE from_address = 'nowak.goran@email.seznam.cz'
   AND created_at < (NOW() - INTERVAL '30 days');
"
```

### 6.3 Auto-advance cron

BFF runs `runLifecyclePhaseAdvanceCron` every day at 03:00 Prague time (UTC+2, or +1 winter).

```bash
# Manually invoke from BFF if needed
curl -s \
  -H "X-Admin-Token: $BFF_ADMIN_TOKEN" \
  "http://localhost:3000/admin/cron/lifecycle-phase-advance" \
  | jq '.'
```

Expected: `{ "advanced": 2 }` (e.g., 2 mailboxes moved to next phase).

---

## 7. RED LINES — Never Do

- **NEVER signup from non-CZ IP**: seznam fraud gate blocks multi-country logins in 30 min → auth_lock (incident 2026-05-09).
- **NEVER reuse password**: Each mailbox must have a unique, random password (operator = easy target for password spray).
- **NEVER skip `daily_cap_override=5`**: Silent bug in legacy ToConfig parsing treats missing as 0 → all sends rejected (memory: `project_tocfg_daily_limit_zero`).
- **NEVER skip `pinned_endpoint_label`**: All outbound traffic MUST route through a single, unique CZ endpoint per mailbox (multi-IP pattern = AP4 fraud trigger).
- **NEVER signup multiple mailboxes in same browser session**: seznam fraud gate correlates browser session fingerprint; use incognito/private for each signup.
- **NEVER dual-purpose mailbox**: Schránka is for campaigns only. No personal use, no test login, no webmail access mid-campaign (IP geolocation change = auth_lock).

---

## 8. Goran Disaster — Lessons & Precedent

**Incident**: 2026-05-09 morning, both `nowak.gorak@email.cz` and `goran.nowak@email.seznam.cz` auth_locked by seznam fraud gate.

**Root cause**: Operator + dev workstation + Mullvad + BFF polling + SMTP sends = 4-7 country IP logins in 30 minutes (one endpoint per device/process).

**Mitigations deployed** (and enforced by this runbook):
1. **Single pinned endpoint per mailbox** (AS sprint, PR #1166): All traffic from one mailbox routes through one SOCKS5 endpoint → consistent IP seen by seznam.
2. **IMAP via SOCKS5 only** (AW7-2, AW7-9): Relay wraps all IMAP connections; localhost + hardened relay = no direct seznam access.
3. **No human webmail access mid-session**: Operator must not login to webmail during active campaign (resets IP geolocation).
4. **Egress chaos alerts** (AP4): If mailbox sees >3 IP sources in 5 min, escalate to Sentry WARN.

---

## 9. Acceptance Criteria

### Before first campaign send on new mailbox:

- [ ] Signup completed from CZ IP (VPN or native).
- [ ] DB row inserted with `lifecycle_phase='warmup_d0'`, `daily_cap_override=5`.
- [ ] `pinned_endpoint_label` assigned and unique (no conflicts).
- [ ] Smoke test passes: `score ≥ 80`, all auth OK.
- [ ] Operator approval documented (issue comment or BOARD.md).
- [ ] No human webmail access after signup.

### Warmup ramp (ongoing):

- [ ] Day 0: ≤5 sends (test batch).
- [ ] Day 3: ≤10 sends.
- [ ] Day 7: ≤25 sends.
- [ ] Day 14: ≤50 sends.
- [ ] Day 30: ≤100 sends.

Auto-advance triggers on midnight Prague time. Operator can manually `UPDATE lifecycle_phase` if needed (e.g., early re-engagement after dormancy).

---

## 10. Troubleshooting

| Symptom | Diagnosis | Fix |
|---------|-----------|-----|
| `curl: (7) Failed to connect` on full-check | BFF not running | `systemctl status outreach-dashboard` or restart |
| `{ "score": 0 }`, no auth fields | Mailbox not in DB | Retry step 3.3 (INSERT), verify `from_address` spelling |
| `score: 15`, `smtp_auth_failed: true` | Wrong password or app-password issue | Reset password in seznam webmail → update DB → re-insert or UPDATE |
| `score: 20`, `imap_auth_ok: true`, `smtp_auth_ok: false` | seznam SMTP requires app-password | Create app-password in seznam settings → update DB |
| `circuit_opened: true` | Mailbox quarantined after 3+ auth failures | Wait 60 minutes (circuit breaker TTL) → retry |
| `auth_locked: true` | seznam fraud gate detected multi-country login | Contact seznam support; mailbox may need manual unlock (2-4 hours) |

---

## 11. Related Documentation

- **Anti-trace pipeline**: `docs/subsystem-maps/anti-trace.md` (42-step email send pipeline).
- **Warmup protection**: `docs/initiatives/2026-05-08-mailbox-lifecycle-protection.md` (AP1 sprint lifecycle enforcement).
- **Egress canonical**: Memory `project_egress_canonical` (Mullvad-only, mode table, wireproxy deployment).
- **Password hygiene**: Memory `feedback_mailbox_passwords_via_db` (HARD RULE: DB/UI only, never env vars).
- **Fraud detection**: Memory `project_seznam_proxy_geo_mismatch` (CZ supply constraint, multi-IP pattern risk).
- **AQ5 issue**: GitHub issue #1121.

---

## Checklist for Operator

Before and after mailbox creation:

- [ ] Reviewed this runbook (sections 1–7).
- [ ] Pre-flight checks passed (pool, personality, Tomáš sign-off).
- [ ] Signup completed from CZ IP, incognito mode.
- [ ] Verified Europa/Prague timezone in seznam profile.
- [ ] DB row inserted, password redacted from logs/chat.
- [ ] Endpoint pinned and verified unique.
- [ ] Smoke test passed (score ≥80).
- [ ] Operator approval documented in issue.
- [ ] No webmail access post-signup.
- [ ] Ready for warmup day 0 (≤5 sends).
