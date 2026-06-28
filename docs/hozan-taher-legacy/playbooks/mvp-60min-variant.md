# Operator Launch Checklist — MVP 60-Min Variant

> **Status:** Active
> **Datum:** 2026-05-01
> **Trigger:** Emergency MVP campaign send — 1–3 existing Seznam mailboxes, deferred security PRs, GitHub Pages privacy URL

Compressed variant of the Phase 0 90-min session (see `docs/playbooks/operator-launch-checklist.md`). This document assumes security PRs are merged separately and focuses on the critical path: verify operator data, configure BFF, load passwords for 1–3 mailboxes, run dry-run, and send smoke test.

**Time commitment: 60 minutes maximum (including post-send monitoring).**

---

## Pre-Session Checklist (5 min)

**Gather before starting:**
- [ ] 1–3 seznam.cz app-specific passwords in password manager (never paste into chat)
- [ ] Railway Postgres `DATABASE_URL` (from Railway dashboard)
- [ ] `OUTREACH_API_KEY` for BFF proxy
- [ ] GitHub Pages URL where privacy notice is deployed (e.g., `messingdev.github.io/garaaage-privacy/`)
- [ ] One test recipient email (operator's own email for smoke test)

**Deploy state:**
- [ ] BFF service running in production (check Railway dashboard)
- [ ] Go outreach service running (check Railway dashboard)
- [ ] 1–3 existing Seznam mailbox records already in database (IDs noted)

---

## 60-Minute Session Flow

The orchestrator script `bash scripts/operator/launch-phase-0.sh --mvp` drives this flow. Each gate requires operator approval (y/n/q) and logs decisions to `docs/audits/launch-mvp-60min.jsonl`.

### Step 1: Operator Data Verification (5 min)

**Gate M1 — Sídlo, Privacy URL, Template**

The script prints:
- Placeholder company identity (will be updated post-send if needed)
- GitHub Pages privacy URL (fetched with curl)
- Current footer template from `features/outreach/campaigns/configs/templates/initial.tmpl`

**Action:** Verify privacy URL is HTTP 200 and template includes unsubscribe link placeholder `{{.UnsubURL}}`. Press `y` to proceed, `n` to halt.

**Privacy URL fallback:** If `garaaage.cz` is not yet accessible, use `https://messingdev.github.io/garaaage-privacy/` (pre-deployed on GitHub Pages).

---

### Step 2: BFF Environment Configuration (5 min)

**Gate M2 — UNSUBSCRIBE_BASE_URL + OUTREACH_API_KEY**

Manual step in Railway dashboard:

1. Open Railway dashboard → BFF service → Variables tab
2. Verify or set `UNSUBSCRIBE_BASE_URL` to one of:
   - `https://garaaage.cz/u` (if deployed), OR
   - `https://messingdev.github.io/garaaage-unsubscribe/` (GitHub Pages fallback)
3. Verify `OUTREACH_API_KEY` matches Go service value
4. Click Restart and wait for BFF to boot (check logs for "listening on port")

**Verify after restart:**
```bash
curl -s https://<bff-hostname>/health | jq .
```

Press `y` once health check passes (expect HTTP 200).

---

### Step 3: Mailbox Password Load (10 min)

**Gate M3 — Load 1–3 mailbox passwords**

Per memory `feedback_mailbox_passwords_via_db`, passwords must be in the database, never in env vars.

**Option A (recommended if BFF running):**
- Open BFF UI → `/mailboxes`
- For each of 1–3 rows, click Edit
- Paste 16-char app password from password manager
- Save (audited automatically)
- Time: 5–7 min

**Option B (direct SQL via psql):**
- Start interactive psql session (credentials from Railway shell)
- Use `\prompt` to paste each password without shell history
- Time: 7–10 min (safer, no UI automation risk)

**Verification SQL (required after update):**
```sql
SELECT count(*) FROM outreach_mailboxes
WHERE smtp_host='smtp.seznam.cz'
  AND status='active'
  AND length(password) >= 16;
-- Expected: 1, 2, or 3 (matching your mailbox count)
```

If count mismatches → retry password load.

Press `y` once verification SQL confirms all mailboxes have passwords.

---

### Step 4: Pre-flight Sanity Check (5 min)

**Gate M4 — Pre-flight validation**

The script invokes `bash scripts/operator/pre-deploy-validate.sh` (same as Phase 0):

- Environment variables present (`OUTREACH_API_KEY`, `DATABASE_URL`, etc.)
- Database connectivity (ping Postgres)
- Pending migrations (must be zero)
- Railway region and branch verified

**Expected output:** All checks green. If any fail, script outputs remediation steps. Address before continuing.

Press `y` once all pre-flight checks pass.

---

### Step 5: Dry-Run Message Render (10 min)

**Gate M5 — Dry-run render (1–3 mailboxes × 1 message)**

The script runs campaign ID 455 dry-run: renders messages for the test recipient, applies personalization, **does not send**.

**Steps:**
1. Script invokes: `cd features/platform/outreach-dashboard && node dry-run.mjs 455 --count=1`
2. Watch stdout for rendered email count (expect 1–3 renders)
3. Inspect sample rendered output:
   - Czech subject line with diacritics (UTF-8)
   - Footer includes GDPR statement and unsubscribe link
   - No encoding errors
4. Verify unsubscribe link format: `https://<UNSUBSCRIBE_BASE_URL>/verify?token=...`

**Expected:** 1–3 emails rendered correctly, no errors, footer present.

Press `y` if dry-run looks correct.

---

### Step 6: Smoke Test to Operator Inbox (10 min)

**Gate M6 — Send 1 email to operator self**

The script sends 1 test email from the first mailbox to the operator's own email address (configured in environment, e.g., `tomas@example.com`).

**Steps:**
1. Script invokes: `cd features/platform/outreach-dashboard && node campaign-send-batch.mjs --dry-test=operator-self`
2. Wait 30–60 seconds for mail to arrive
3. Operator checks inbox for one email from the first mailbox's `from_address`
4. Inspect headers:
   - `From:` matches mailbox configuration
   - `Reply-To:` matches mailbox address (Gmail requirement)
   - Subject line is UTF-8 (Czech diacritics visible)
5. Click unsubscribe link → expect redirect to UNSUBSCRIBE_BASE_URL and success page

**Expected:** Email arrives in inbox (not spam), headers correct, unsubscribe link functional.

Press `y` if email arrives and unsubscribe works.

---

### Step 7: GO / NO-GO Decision (5 min)

**Gate M7 — GO/NO-GO for first batch send**

All technical gates are green. This is the final approval decision.

The script confirms:
- All 6 gates completed
- Operator understands: no warm-up schedule in MVP variant (send 1–3 messages immediately)
- Operator acknowledges hard rule: once GO is pressed, send cannot be recalled (per memory `feedback_campaign_send`)

**Hard RULE reminder:** Campaign 455 will send 1–3 test messages immediately. No staircase warm-up. Operator assumes responsibility for verifying deliverability and handling replies.

**Action:**
- Press `y` to GO: script records "GO" to audit log and prints: `cd features/platform/outreach-dashboard && node campaign-send-batch.mjs 455 --count=1`
- Press `n` to defer: script exits without sending; operator can re-run later

**If GO is approved:**
- Operator runs the command when ready
- Monitor first 1–3 deliveries (2–5 min) for SMTP errors (expect 0 errors on success)
- Check Sentry immediately for `DELIVERY_FAILED` alerts (expect none)

---

## Post-Send Verification (If GO Approved)

**First 5 minutes (during send):**
- Watch stdout for SMTP delivery progress (expect "delivered" messages)
- Check Sentry dashboard for errors (expect none or 0 critical alerts)

**After send completes:**
- Query DB to verify delivery recorded:
  ```sql
  SELECT count(*) FROM tracking_events
  WHERE campaign_id=455 AND event_type='delivered';
  -- Expected: 1, 2, or 3 (matching mailbox count)
  ```

**Rollback triggers (if needed):**
- SMTP authentication failure → check mailbox password in DB (re-run Gate M3)
- Delivery failure >0 → check Sentry + Go service logs for relay issues
- Privacy URL not accessible in email footer → verify UNSUBSCRIBE_BASE_URL in BFF env vars

---

## Reference Links

**Full 90-min session:** `docs/playbooks/operator-launch-checklist.md` — phase 0 comprehensive checklist with 24 mailboxes and 17 security PRs

**Supporting materials:**
1. **Mailbox passwords:** `docs/playbooks/kt-a4-mailbox-password-update.md` — password update procedure
2. **BFF deployment:** Railway dashboard UI (manual steps, no separate playbook needed)
3. **Pre-flight script:** `scripts/operator/pre-deploy-validate.sh`
4. **Template:** `features/outreach/campaigns/configs/templates/initial.tmpl`
5. **Privacy notice:** GitHub Pages deployment (e.g., `messingdev.github.io/garaaage-privacy/`)
6. **GDPR compliance:** `docs/legal/privacy-notice.md` — legal basis and footer statement

---

## Deferred Tasks (Post-Send)

The following **17 security PRs** are merged separately (before or after send, no impact on MVP flow):
- XFF trusted-proxy filters
- Timing-safe token comparison
- Response sanitization
- CSP headers
- Thread closure on unsubscribe
- Backpressure on bounces
- Advisory lock safety
- SQL injection parameterization
- Authentication matrix tests
- (Additional 8 items — see `docs/audits/2026-04-30-security-pr-review-pack.md`)

**Integration flow:** Merge security PRs to `main`, then deploy BFF restart via Railway. No re-run of MVP checklist needed.

---

## Session Checklist

**Before starting (5 min)**
- [ ] Password manager open with 1–3 app passwords
- [ ] Railway dashboard open (Postgres + BFF tabs)
- [ ] Terminal at git root: `/Users/messingtomas/Documents/Projekty/hozan-taher`
- [ ] `git status` clean

**During session (50–55 min)**
- [ ] Gate M1: Sídlo + privacy URL + template verified — 5 min
- [ ] Gate M2: BFF env vars set, restarted, health check passes — 5 min
- [ ] Gate M3: 1–3 mailbox passwords loaded and verified (SQL count OK) — 10 min
- [ ] Gate M4: Pre-flight checks passed (all green) — 5 min
- [ ] Gate M5: Dry-run rendered 1–3 test emails (no errors) — 10 min
- [ ] Gate M6: Smoke test email arrived in inbox, unsubscribe link works — 10 min
- [ ] Gate M7: GO/NO-GO decision made and recorded — 5 min

**After session (if GO approved, 5–10 min)**
- [ ] Run send command (operator initiates)
- [ ] Monitor 1–3 deliveries (2–5 min)
- [ ] Check Sentry (0 critical alerts expected)
- [ ] Record send completion time in `docs/audits/launch-mvp-60min.jsonl`

---

## Hard Rules

1. **No passwords in chat / env vars / commits.** Passwords in password manager only. (Memory `feedback_mailbox_passwords_via_db`)
2. **No campaign send without explicit GO approval.** Once pressed, send cannot be recalled. (Memory `feedback_campaign_send`)
3. **All loaded mailboxes must have non-empty passwords.** Pre-flight gate enforces this; bypass not allowed.
4. **Template footer must include GDPR statement + unsubscribe link.** Verified in Gate M1; no send without it.

---

## Abort & Retry

If any gate fails:

1. Press `n` to defer the failing gate
2. Script exits cleanly; audit log records blocker
3. Operator fixes blocker (e.g., restart BFF, update password, check privacy URL)
4. Re-run script: `bash scripts/operator/launch-phase-0.sh --mvp` (completed gates skip automatically)

**Common blockers:**
- BFF health check fails → check Railway logs, wait for boot, retry Gate M2
- Mailbox password mismatch → retry password update in password manager, then Gate M3
- Pre-flight fail (DB unreachable) → verify `DATABASE_URL`, check Railway status, retry Gate M4
- Privacy URL 4xx → deploy missing service or use GitHub Pages fallback, retry Gate M1
- Dry-run encoding errors → check template UTF-8 encoding, fix `initial.tmpl`, retry Gate M5

---

## Time Allocation Summary

| Step | Time | Outcome |
|------|------|---------|
| Pre-session prep | 5 min | Passwords + docs ready |
| Gate M1: Data verify | 5 min | Sídlo + privacy + template OK |
| Gate M2: BFF env | 5 min | UNSUBSCRIBE_BASE_URL set + restarted |
| Gate M3: Mailbox pwd | 10 min | 1–3 passwords loaded, SQL verified |
| Gate M4: Pre-flight | 5 min | All checks green |
| Gate M5: Dry-run | 10 min | 1–3 emails rendered, no errors |
| Gate M6: Smoke test | 10 min | 1 test email arrived + unsub link works |
| Gate M7: GO/NO-GO | 5 min | Decision recorded |
| **Post-send monitoring** | **5–10 min** | **1–3 deliveries confirmed** |
| **Total** | **~60 min** | **MVP send complete** |

---

## Audit & Escalation

- All decisions logged to `docs/audits/launch-mvp-60min.jsonl` (timestamp, gate, status)
- Sentry integration: CRITICAL alerts sent if SMTP/relay issues detected
- On abort: operator notes reason; coordinator reviews blocker
- On GO: final timestamp recorded for post-mortem analysis

---

## Key Differences from Phase 0 (90-min)

| Aspect | Phase 0 (90-min) | MVP (60-min) |
|--------|------------------|------------|
| Mailboxes | 24 (full fleet) | 1–3 (existing) |
| Security PRs | 17 merged in-session | Deferred (separate merge) |
| Privacy URL | garaaage.cz deployed | GitHub Pages fallback allowed |
| Company identity | Final, verified | Placeholder ("bude doplněno" allowed for test) |
| Warmup schedule | 2 msgs/day, day 1–15 plateau | No warmup (1–3 immediate) |
| Session time | 90 min | 60 min |
| Pre-flight gates | 7 gates | 7 gates (same safety checks) |
| Test recipient | Operator self | Operator self |
| Post-send monitoring | 60+ deliveries tracked | 1–3 deliveries verified |

---

## Session End Checklist

- [ ] Audit log file `docs/audits/launch-mvp-60min.jsonl` contains all 7 gate entries (or fewer if deferred)
- [ ] All passwords **removed from terminal history** (`history | grep password` = empty)
- [ ] BFF + Go services remain running
- [ ] If GO: campaign 455 send initiated (or not, if NO-GO was chosen)
- [ ] If GO: 1–3 deliveries confirmed in tracking_events table
