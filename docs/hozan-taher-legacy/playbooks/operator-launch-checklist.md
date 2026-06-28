# Operator Launch Checklist — Phase 0 90-Min Session

> **Status:** Active
> **Datum:** 2026-05-01
> **Trigger:** Phase 0 campaign launch — 24 mailbox fleet sending to machinery dealers

A single-page pre-session pack for the operator launching the first B2B campaign. This checklist consolidates parallel preparation work, 17 security PRs, 24 mailbox setup, and staged warmup send into one focused 90-minute session.

---

## Pre-Session Checklist

Before sitting down, gather and verify the following. **Do not proceed if any item is missing or unconfirmed.**

**Credentials & Secrets (secure in password manager, never paste into chat)**
- [ ] 24 Seznam.cz app-specific passwords (one per mailbox account) — generated from `https://email.seznam.cz/ → Developer Settings → App Passwords`
- [ ] Sentry DSN `SENTRY_AUTH_TOKEN` if Sentry dashboard access needed for post-send alerts
- [ ] Railway Postgres `DATABASE_URL` (full connection string, not env var — available from Railway dashboard)
- [ ] `OUTREACH_API_KEY` for BFF API calls (matches Go service `X-API-Key` header)

**Business Data (confirm with stakeholder)**
- [ ] Company identity: **Garaaage s.r.o., IČO 23219700, Purkyňova 74/2, 110 00 Praha 1** — verbatim in footer
- [ ] Privacy URL deployed and accessible: **https://garaaage.cz/privacy** (HTTP 200 response)
- [ ] Email template finalized: `features/outreach/campaigns/configs/templates/initial.tmpl` (Czech language, no encoding errors, unsubscribe link placeholder `{{.UnsubURL}}` present)
- [ ] Warmup configuration verified: `features/outreach/campaigns/configs/warmup.yaml` contains `vykup_24mb` plan (24-mailbox, 2 msgs/day starting day 1, plateau day 15)

**Deployment State (verify railway logs)**
- [ ] BFF service running in production (check Railway dashboard)
- [ ] Go outreach service running (check Railway dashboard)
- [ ] `UNSUBSCRIBE_BASE_URL=https://garaaage.cz/u` env var set in BFF service (Railway dashboard → variables)
- [ ] 24 Seznam mailbox records inserted in DB (if not done, coordinator must run SQL batch first)

---

## 90-Minute Session Flow

The orchestrator script `bash scripts/operator/launch-phase-0.sh` drives this flow interactively. Each gate requires operator approval (y/n/q) and logs decisions to `docs/audits/launch-phase-0.jsonl`.

### Step 1: Security PRs Review Batch (30 min)

**Gate 1 / 7 — KT-A1: 17 security PRs**

The script detects open security PRs matching pattern `sec: F1- F2- F3- F5- W2-` and invokes `scripts/operator/security-batch-merge.sh`. This is a pre-recorded batch of 17 security-critical fixes (see `docs/audits/2026-04-30-security-pr-review-pack.md` for full list).

Per PR (~5 min review):
- Skim PR title and diff summary
- Check local test report (all should be green)
- Press `y` to approve admin-merge to main, or `n` to defer (gates subsequent steps)

**Security PRs scope:** fail-closed HMAC gates, XFF trusted-proxy filters, timing-safe token comparison, response sanitization, CSP headers, thread closure on unsubscribe, backpressure on bounces, advisory lock safety, SQL injection parameterization, auth matrix tests.

**Critical:** If any PR fails local tests or reviewer concern → press `n`, abort script, report to coordinator.

---

### Step 2: Operator Data Verification (10 min)

**Gate 2 / 7 — KT-A2: Sídlo, privacy URL, template**

The script prints:
- Registered company identity (verify Garaaage details against business documents)
- Privacy URL and fetches it (expect HTTP 200)
- Current footer template from `initial.tmpl` (verify unsubscribe link, GDPR footer, no encoding issues)

**Action:** Review visually, confirm all three match business records. Press `y` to proceed, `n` to halt (privacy URL is 4xx/5xx = mandatory fix).

---

### Step 3: Railway BFF Deploy (15 min)

**Gate 3 / 7 — KT-A3: BFF deploy + UNSUBSCRIBE_BASE_URL**

The script guides manual steps in Railway dashboard. This step assumes BFF is already deployed; you are verifying and setting environment variables.

**Steps:**
1. Open Railway dashboard → BFF service
2. Confirm service is running (green status)
3. Go to Variables tab → verify `UNSUBSCRIBE_BASE_URL=https://garaaage.cz/u` is set
4. Confirm `OUTREACH_API_KEY` matches the Go service value (copy from Go service variables if needed)
5. Click Restart to apply env changes
6. Wait for BFF to boot (check logs for "listening on port")

**Verify after restart:**
- BFF health endpoint returns 200: `curl -s https://<bff-hostname>/health | jq .`
- If CSP header present (from security PR #165), expect strict header in response

Press `y` once restart is confirmed and health check passes.

---

### Step 4: 24 Mailbox Passwords Update (15 min)

**Gate 4 / 7 — KT-A4: Load 24 mailbox credentials**

This gate verifies all 24 mailbox records have passwords loaded. Per `docs/playbooks/kt-a4-mailbox-password-update.md`, credentials must be in DB, never in env vars.

**Methods (choose one):**

**Option A (recommended if BFF is running):** Open BFF UI → `/mailboxes` → for each of 24 rows, click Edit, paste 16-char app password from password manager, Save. (10–15 min, audited automatically)

**Option B (direct SQL via psql):** Start interactive psql session (credentials in Railway shell), use `\prompt` to paste passwords per mailbox without shell history. (15–20 min, requires manual audit log INSERT after)

**Option C (Railway UI):** Edit `outreach_mailboxes.password` cell per row via pgAdmin interface. (20–25 min, slowest, manual audit log entry required)

**Verification SQL (required after update):**
```sql
SELECT count(*) FROM outreach_mailboxes 
WHERE smtp_host='smtp.seznam.cz' 
  AND status='active' 
  AND length(password) >= 16;
-- Expected: 24
```

If count < 24 → some mailboxes missing passwords. Retry step 4.

Press `y` once verification SQL confirms all 24.

---

### Step 5: Pre-flight Sanity Gate (10 min)

**Gate 5 / 7 — KT-A5.1: Pre-flight check**

The script invokes `bash scripts/operator/pre-deploy-validate.sh`, which runs automated checks:
- Environment variables present and non-empty (`OUTREACH_API_KEY`, `DATABASE_URL`, etc.)
- Database connectivity (ping Postgres)
- Pending migrations (must be zero)
- Railway region and branch verified
- No test/staging artifacts left over

**Expected output:** All checks green. If any fail, script outputs remediation steps. Address before continuing.

Press `y` once all pre-flight checks pass.

---

### Step 6: Dry-Run (15 min)

**Gate 6 / 7 — KT-A5.2: Dry-run message render**

The script runs campaign ID 455 dry-run: renders all messages, builds template personalization, applies spintax/humanization, **does not send**.

**Steps:**
1. Script invokes: `cd features/platform/outreach-dashboard && node dry-run.mjs 455`
2. Watch stdout for rendered email count (expect 24 × 1 = 24 test renders for initial step)
3. Inspect sample rendered output (check Czech subject line, footer, unsubscribe link)
4. Verify no encoding issues (expect UTF-8 subject line with diacritics)

**Expected:** 24 emails rendered, no errors, sample shows correct footer + unsubscribe link.

Press `y` if dry-run output looks correct (no encoding errors, footer present).

---

### Step 7: Send-Test (10 min)

**Gate 7 / 7 — KT-A5.3: Smoke test to operator inbox**

The script sends 1 test email from the first mailbox to the operator's own email address (hardcoded in environment, e.g. `tomas@example.com`). This verifies end-to-end SMTP, authentication, header formatting, and unsubscribe URL generation.

**Steps:**
1. Script invokes: `cd features/platform/outreach-dashboard && node campaign-send-batch.mjs --dry-test=operator-self`
2. Wait 30–60 seconds for mail to arrive
3. Operator checks inbox for one email from `<from_address>` of first mailbox
4. Inspect headers:
   - `From:` header matches mailbox `from_address`
   - `Reply-To:` header matches `from_address` (Gmail requirement)
   - `Subject:` line is UTF-8 encoded (Czech diacritics present)
5. Click unsubscribe link in footer → expect redirect to `https://garaaage.cz/u?...` and success page

**Expected:** Email arrives in inbox (not spam), headers correct, unsubscribe link works.

Press `y` if email arrives and unsubscribe link is functional.

---

### Final Gate: GO / NO-GO Decision (10 min)

**Final Gate — GO/NO-GO: Campaign launch approval**

All 7 technical gates are green. This final gate is the business decision point. The script confirms:
- All gates completed
- Operator understands warmup schedule (day 1–2 sends 2 msgs/mailbox = 48 msgs; ramps to 20/mailbox/day = 480 msgs max)
- Operator acknowledges hard rule: campaign send cannot be recalled (per memory `feedback_campaign_send`)

**Hard RULE reminder:** Once GO is pressed, campaign 455 will begin sending. First batch is 48 messages to dealer contacts sourced from firmy.cz. Operator assumes responsibility for reply triage and unsubscribe handling.

**Action:** Review `docs/strategy/2026-04-30-m3-minimal-scope.md` Section 3 acceptance criteria if unclear. Press `y` to GO, or `n` to defer (script exits without sending).

**If GO is approved:**
- Script records "GO" to audit log
- Prints manual send command: `cd features/platform/outreach-dashboard && node campaign-send-batch.mjs 455 --staircase`
- Operator runs the command when ready
- Monitor first 60 deliveries (5–10 min) for bounces, SMTP errors (expect <5% bounce rate)

---

## Post-Send Verification (If GO Approved)

If operator presses GO and runs the staircase send command:

**First 10 minutes:**
- Watch stdout for SMTP delivery progress (should show "delivered" count increasing)
- Check Sentry for `DELIVERY_FAILED` alerts (expect none or <5%)
- Monitor operator's reply inbox (should be empty for ~2 hours, then first replies arrive)

**After 60 messages delivered:**
- Query DB: `SELECT count(*) FROM tracking_events WHERE campaign_id=455 AND event_type='delivered'`
- Expected: ~60–100 (allows for slow network, DNS delays)
- If <30: halt further sends, check Sentry + logs for relay issues

**After 24 hours:**
- Check reply triage queue: `SELECT count(*) FROM outreach_threads WHERE campaign_id=455`
- Expected: ~5–15 replies (~10% reply rate is healthy for cold outreach)
- Check bounce suppression: `SELECT count(*) FROM outreach_suppressions WHERE campaign_id=455 AND reason='bounce'`
- Expected: <5 (bounce rate <5%)

**Rollback triggers (stop further sends immediately):**
- Bounce rate >5% (hard bounce from Seznam or recipient)
- Sentry CRITICAL alert (e.g. database constraint violation, security incident)
- Reply override rate >50% in first 10 replies (operator rejecting AI suggestions, suggests poor targeting)

---

## Reference Links (Existing Playbooks)

Detailed procedures for each step are documented in:

1. **Security PRs:** `docs/audits/2026-04-30-security-pr-review-pack.md` — full list of 17 PRs + per-PR rationale
2. **Mailbox passwords:** `docs/playbooks/kt-a4-mailbox-password-update.md` — detailed 4-option password load procedure
3. **BFF deployment:** `docs/playbooks/kt-a3-bff-deploy-checklist.md` (if exists; fallback: Railway docs)
4. **Pre-flight:** `scripts/operator/pre-deploy-validate.sh` — sanity gate script
5. **Warmup curve:** `features/outreach/campaigns/configs/warmup.yaml` — `vykup_24mb` plan definition
6. **Template:** `features/outreach/campaigns/configs/templates/initial.tmpl` — email template final version
7. **GDPR footer:** `docs/legal/privacy-notice.md` — legal basis + retention statement
8. **Campaign scope:** `docs/strategy/2026-04-30-m3-minimal-scope.md` — Phase 0 goals + acceptance criteria
9. **First campaign plan:** `docs/playbooks/FIRST-CAMPAIGN-PLAN.md` — detailed segment targeting, reply loop, verification traps

---

## Task Checklist (Per Session)

**Before starting (15 min setup)**
- [ ] Password manager (1Password / Bitwarden) open with 24 Liste.cz app passwords visible
- [ ] Railway dashboard open in browser (Postgres + BFF service tabs)
- [ ] Terminal at git root: `/Users/messingtomas/Documents/Projekty/hozan-taher`
- [ ] `git status` clean (no unsaved work)

**During session (75 min)**
- [ ] Gate 1: Security PRs batch merged (y/n/q per PR) — ~30 min
- [ ] Gate 2: Operator data verified (sídlo + privacy + template) — ~10 min
- [ ] Gate 3: BFF deployed, env vars set, restarted — ~15 min
- [ ] Gate 4: 24 mailbox passwords loaded and verified (SQL count=24) — ~15 min
- [ ] Gate 5: Pre-flight checks passed (all green) — ~10 min
- [ ] Gate 6: Dry-run rendered 24 test emails (no errors) — ~15 min
- [ ] Gate 7: Send-test email arrived in inbox, unsubscribe link works — ~10 min
- [ ] Final Gate: GO/NO-GO decision made and recorded — ~10 min

**After session (if GO approved)**
- [ ] Run staircase send command (operator initiates)
- [ ] Monitor first 60 deliveries (5–10 min)
- [ ] Check Sentry for alerts
- [ ] Record send completion time in `docs/audits/launch-phase-0.jsonl`

---

## Abort Scenarios

**If any gate fails or operator uncertainty arises:**

1. Press `n` to defer the failing gate
2. Script exits cleanly; audit log records `{"status":"blocked","gate":"KT-AX","note":"..."}`
3. Coordinator reviews blocker + remediation
4. Re-run script from the beginning (gates marked as "done" skip re-execution)

**Common blockers:**
- Security PR test failures → fix in original PR branch, re-merge via script
- Privacy URL 4xx/5xx → deploy missing service or fix DNS, re-run Gate 2
- BFF env var missing → add to Railway, restart, re-run Gate 3
- Mailbox password mismatch (length ≠ 16) → generator issues, retry password gen in Seznam UI
- Pre-flight fail (DB unreachable) → check Railway logs, verify `DATABASE_URL` env var, retry Gate 5
- Dry-run encoding errors → check template file encoding (should be UTF-8), fix `initial.tmpl`, re-run Gate 6

---

## HARD RULES (Non-Negotiable)

1. **No passwords in chat / env vars / commits / Slack.** Passwords live in password manager only. (Memory `feedback_mailbox_passwords_via_db`)
2. **No campaign send without explicit GO approval.** Once pressed, send cannot be recalled. (Memory `feedback_campaign_send`)
3. **Bounce rate >5% = halt.** Monitor first batch and stop further sends if bounce rate exceeds 5%. (KT-A5 rollback trigger)
4. **All 24 mailboxes must be active before send.** Pre-flight gate enforces this; bypass not allowed. (Schema verification § Gate 4)
5. **Template footer must include GDPR footer with unsubscribe link.** Verified in Gate 2; no send without it. (Legal requirement)

---

## Time Allocation Summary

| Step | Time | Outcome |
|------|------|---------|
| Pre-session prep | 15 min | Credentials + docs ready |
| Gate 1: Security PRs | 30 min | 17 PRs reviewed + merged |
| Gate 2: Data verify | 10 min | Sídlo + privacy + template OK |
| Gate 3: BFF deploy | 15 min | Env vars set, service restarted |
| Gate 4: Mailbox pwd | 15 min | 24 passwords loaded, SQL verified |
| Gate 5: Pre-flight | 10 min | All checks green |
| Gate 6: Dry-run | 15 min | 24 emails rendered, no errors |
| Gate 7: Send-test | 10 min | 1 smoke test arrived + unsub link works |
| Final GO/NO-GO | 10 min | Decision recorded |
| **Post-send monitoring** | **5–10 min** | **First 60 deliveries monitored** |
| **Total** | **~135 min** | **Launch complete** |

(First 90 min in-session; post-send monitoring if GO is approved.)

---

## Audit & Escalation

- All decisions logged to `docs/audits/launch-phase-0.jsonl` (timestamp, gate, status, operator note)
- Sentry integration: sends CRITICAL alerts to operator's configured channel if relay/SMTP issues detected
- On abort: operator notes reason; coordinator reviews and proposes remediation (GH issue comment)
- On GO: final recorded timestamp enables post-mortem analysis of campaign performance vs timeline

---

## Coordinator Handoff Notes

If operator defers or encounters blocker:

1. **Coordinator reads** `docs/audits/launch-phase-0.jsonl` to understand which gate failed
2. **Coordinator fixes** blocker in main branch (e.g. redeploy BFF, fix template, etc.)
3. **Coordinator confirms** with operator blocker is resolved
4. **Operator re-runs** full script (completed gates skip automatically via audit log)
5. **Final GO** on 2nd attempt if all gates now pass

This pattern avoids partial rollback or state corruption.

---

## Session End Checklist

- [ ] Audit log file `docs/audits/launch-phase-0.jsonl` contains all 8 gate entries (or fewer if deferred)
- [ ] All passwords are **removed from terminal history** (`history | grep password` = empty)
- [ ] BFF + Go services remain running (no accidental shutdown during session)
- [ ] If GO: campaign 455 send staircase initiated (or not, if NO-GO was chosen)
- [ ] If GO: first 60 deliveries confirmed (Sentry + reply queue)
