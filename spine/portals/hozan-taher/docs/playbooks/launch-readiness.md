# Launch readiness — anti-trace egress decision matrix

**Audience:** operator, before activating any production campaign.
**Cross-refs:** [`docs/subsystem-maps/anti-trace.md`](../subsystem-maps/anti-trace.md), `features/outreach/relay/CLAUDE.md`, memory `seznam_proxy_geo_mismatch`.

This runbook documents the **architectural ceiling** of the anti-trace email pipeline and the three operator-decidable launch paths around it.

## What `pnpm report` will show

After CAD-M2 (PR introducing this doc), `pnpm report` has a new section:

```
Egress sanity (anti-trace egress IP + transport)
─────────────────────────────────────────────
  transport_mode:        socks5
  wireproxy:             active
  current_egress_ip:     185.213.155.74
  mullvad_peer_endpoint: praha-wg-001.mullvad.net:51820
```

A drift triggers a **critical** bottleneck and `RTH=NE`:

```
✗ egress country drift  actual=CN expected=CZ — Mullvad peer config wrong, fix WIREPROXY_CONFIG on Railway
```

Set `EXPECTED_EGRESS_COUNTRIES=CZ` (or comma-list) in the BFF env to control the allowlist.

## The architectural ceiling — read this once

Documented in `features/outreach/relay/CLAUDE.md`:

> Even with Mullvad CZ exit, Seznam (and other Czech recipient SMTP servers) reject mail from Mullvad IPs as anti-VPN reputation. The egress architecture is operationally complete; final-mile delivery to Czech webmail providers requires a non-VPN sending IP (own CZ VPS / transactional email service).

**This is not a bug. The pipeline does what it can. Recipient reputation systems are the constraint.**

Symptom seen 2026-05-01: 36 envelopes sealed by relay, 0/18 reached `@email.cz` IMAP — Seznam silent-dropped because the relay's egress IP was a Mullvad IP, regardless of country.

## Decision matrix — three launch paths

Pick one before activating campaign 455 (or any production campaign):

### A) Accept reduced delivery rate (fastest, lowest commitment)

- Launch with current Mullvad config.
- Monitor: bounce events, IMAP-side reply rate, recipient complaints (if any).
- Expected: 30–60 % delivery to inbox vs spam folder for Czech webmail. Higher for non-Czech recipients.
- Operator effort: zero. Just hit Spustit.
- **Use when:** the campaign cohort is non-time-critical and you can iterate on response rate.

**Required preflight green:** mailbox_passwords ✓, suppression_union ✓, templates ✓, privacy_url ✓, dns ✓, egress_country=CZ ✓ (Mullvad CZ exit, even if anti-VPN flagged).

### B) Pivot to own CZ VPS (medium commitment, fundamental fix)

- Acquire CZ VPS (Hetzner/Vultr/CZ.NIC, ~€5–15/mo).
- Run a SOCKS5 server on the VPS (Dante or 3proxy).
- Update Railway anti-trace-relay env:
  ```
  TRANSPORT_MODE=socks5
  SOCKS_PROXY_ADDR=<vps-public-ip>:<port>
  WIREPROXY_CONFIG=          # unset, no longer needed
  ```
- Redeploy relay service.
- Verify via `pnpm report` Egress sanity that `current_egress_ip` is the VPS IP.
- **Use when:** Czech webmail is the primary recipient pool and delivery rate matters.

**Caveat:** the VPS IP starts with no reputation. Warm up gradually. Do NOT immediately send 20+ emails on day 1 from a fresh VPS — Seznam may grey-list a fresh non-Mullvad IP without history. Use the existing warmup-day mechanism (`mailbox_warmup` table) to ramp.

### C) Transactional email service (highest commitment, architectural change)

- Sign up with Mailgun / Postmark / SendGrid CZ origin pool.
- Bypass the relay entirely.
- Code change: campaigns/sender/Engine constructed with a different transport interface (NOT `AntiTraceClient`). Requires:
  - New `sender.TransactionalClient` type implementing the same shape as `AntiTraceClient`
  - `Engine.WithTransactional(client)` method
  - Audit ratchet update — both Engine.WithAntiTrace AND Engine.WithTransactional must be the only construction sites
  - Per-recipient unsubscribe headers (`List-Unsubscribe`) become the provider's responsibility
- **Use when:** scaling beyond 50 emails/day with high deliverability target.

**This is F3 territory** — separate initiative, not part of CAD-M (Codebase Awareness Discipline).


## Automated launch verify

Replaces the manual 7-step checklist with a single command that chains all gates:

```bash
pnpm verify:launch --campaign-id=455
```

Optional flags:
- `--mode=live` — also probes DB write capability (INSERT+DELETE synthetic row in `send_events`). Default is `dry-run` (read-only).
- `--json` — machine-readable output for CI/scripting.

The command runs five gates in order:

| Step | Gate | Contract |
|------|------|----------|
| 1 | **Egress sanity** | `GET /api/anti-trace/egress` via BFF — must return `transport_mode=socks5` and `egress_country_iso` in `EXPECTED_EGRESS_COUNTRIES` (default `CZ`). Defined in `features/platform/outreach-dashboard/scripts/system-report.mjs` egress probe. |
| 2 | **BFF preflight** | `POST /api/campaigns/:id/run` with `x-preflight-only: 1` header — must return HTTP 200 with no blockers. Blocker shape: `{ code, label, detail, action_url }`. Defined in `features/platform/outreach-dashboard/src/server-routes/runPreflight.js`. |
| 3 | **SMTP AUTH probe** | Relay `POST /v1/probe` for each active mailbox — all must pass. Uses `RELAY_BASE_URL` env. |
| 4 | **Template render dry-run** | Samples 5 enrolled contacts, renders `sequence_config[0].template`, verifies GDPR footer (`/unsubscribe?`) and no unresolved `{{}}` placeholders. |
| 5 | **DB write capability** | `--mode=live` only: writes a synthetic `send_events` row (`status='probe'`) and immediately deletes it. Proves write access before campaign activation. Skipped in `--mode=dry-run`. |

All-pass → exit 0, prints `✓ READY TO LAUNCH`.
Any-fail → exit 1, numbered failure list with `action_url` per failure.

**NOTE:** the script never sends real email. Even `--mode=live` only touches a transient synthetic row. Campaign `status` is never changed.

Source: `scripts/verify-launch.mjs`. Tests: `features/platform/outreach-dashboard/tests/unit/scripts/verify-launch.test.mjs`.

## Pre-launch checklist (manual fallback)

Use the automated command above. The items below are the individual gates it exercises — only consult manually if the BFF is down and you need to diagnose which gate is red.

Before clicking Spustit on a production campaign:

1. **Decision made** — A, B, or C. Logged in this doc as a comment commit.
2. **`pnpm report` green** — RTH=100 % or RTH=ANO (waiting for window).
3. **Egress sanity green** — `transport_mode=socks5`, `wireproxy=active`, `current_egress_ip` not empty, `mullvad_peer_endpoint` matches expected (or VPS IP for path B).
4. **Mailbox cooldowns clear** — `pnpm report` shows no `circuit_opened_at` non-null.
5. **Daily caps NOT exhausted** — if running mid-day, check `outreach_mailboxes.sent_today` per mailbox.
6. **Suppression UNION fresh** — both `outreach_suppressions` and `suppression_list` reachable.
7. **Privacy URL alive** — `garaaage.cz/privacy` returns 200/204 (preflight P4).

If any item red: do not launch.

## What NOT to do

- ❌ Bypass the relay with direct SMTP (audit ratchet `airtight_audit_test.go` blocks).
- ❌ Construct `sender.NewAntiTraceClient` directly outside `engine.go` (audit ratchet `no_bypass_audit_test.go`, planned M3).
- ❌ Send from a fresh Mullvad IP without warmup ramp.
- ❌ Send 36 emails in 100 seconds to recipients on the same provider (burst spam-flag pattern, observed 2026-05-01).
- ❌ Change Mullvad peer endpoint without redeploying relay AND running smoke probe via `pnpm report`.

## Maintenance

When CZ Mullvad peer endpoint changes (Mullvad rotates servers occasionally):
1. Update `WIREPROXY_CONFIG` env var on Railway anti-trace-relay service.
2. Trigger Railway redeploy.
3. Wait 60 seconds.
4. Run `pnpm report` — Egress sanity should show new peer endpoint and IP.
5. If `current_egress_ip` country changed, decision matrix needs re-review.

## GDPR footer — required template structure (issue #585)

Every email template body (both in `configs/templates/*.tmpl` AND in `email_templates` DB rows) must carry:

```
Odhlásit se: {{.UnsubURL}} | Napište STOP a víc se neozvu.
Správce údajů: Garaaage s.r.o., IČO 23219700, sídlo Praha.
Právní základ: oprávněný zájem (čl. 6(1)(f) GDPR, Recital 47 — přímý marketing B2B).
Zdroj kontaktu: veřejný rejstřík firmy.cz.
Privacy policy: https://garaaage.cz/privacy
```

**Required fields** (locked in `features/outreach/campaigns/content/gdpr_footer_audit_test.go`):
- `{{.UnsubURL}}` — per-recipient HMAC unsub link (HARD RULE in CLAUDE.md red lines)
- `STOP` — keyword opt-out fallback (zákon č. 480/2004 § 7/4)
- `Garaaage s.r.o.` — controller identity
- `IČO 23219700` — controller registration ID
- `Praha` — controller seat
- `čl. 6(1)(f)` — legal basis citation
- `Recital 47` — direct-marketing legitimate-interest exemption
- `firmy.cz` — data source
- `https://garaaage.cz/privacy` — canonical privacy policy URL

### DB rows for campaign 455 — operator SQL (DO NOT AUTO-EXECUTE)

The `email_templates` rows for campaign 455 (IDs 1889, 1890, 1891) do **not** contain `{{.UnsubURL}}`.
The `.tmpl` files have been fixed in the codebase (issue #585 fix commit) but DB rows are independent.

**Before running this update, verify the template bodies look correct in the UI first.**

```sql
-- intro_machinery (id=1889): append GDPR footer
UPDATE email_templates
SET body = body || E'\n\nOdhlásit se: {{.UnsubURL}} | Napište STOP a víc se neozvu.\nSprávce údajů: Garaaage s.r.o., IČO 23219700, sídlo Praha.\nPrávní základ: oprávněný zájem (čl. 6(1)(f) GDPR, Recital 47 — přímý marketing B2B).\nZdroj kontaktu: veřejný rejstřík firmy.cz.\nPrivacy policy: https://garaaage.cz/privacy'
WHERE id = 1889;

-- followup_1 (id=1890): append GDPR footer
UPDATE email_templates
SET body = body || E'\n\nOdhlásit se: {{.UnsubURL}} | Napište STOP a víc se neozvu.\nSprávce údajů: Garaaage s.r.o., IČO 23219700, sídlo Praha.\nPrávní základ: oprávněný zájem (čl. 6(1)(f) GDPR, Recital 47 — přímý marketing B2B).\nZdroj kontaktu: veřejný rejstřík firmy.cz.\nPrivacy policy: https://garaaage.cz/privacy'
WHERE id = 1890;

-- followup_2 (id=1891): append GDPR footer
UPDATE email_templates
SET body = body || E'\n\nOdhlásit se: {{.UnsubURL}} | Napište STOP a víc se neozvu.\nSprávce údajů: Garaaage s.r.o., IČO 23219700, sídlo Praha.\nPrávní základ: oprávněný zájem (čl. 6(1)(f) GDPR, Recital 47 — přímý marketing B2B).\nZdroj kontaktu: veřejný rejstřík firmy.cz.\nPrivacy policy: https://garaaage.cz/privacy'
WHERE id = 1891;
```

**Verify after update:**
```sql
SELECT id, name, body LIKE '%{{.UnsubURL}}%' as has_unsub FROM email_templates WHERE id IN (1889,1890,1891);
```

Expected: all three rows return `has_unsub = true`.

The `template_render` gate in `verify-launch.mjs` checks for `{{.UnsubURL}}` placeholder presence after render — it will stay RED until the DB rows are updated.
