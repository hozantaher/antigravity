# Live SMTP Relay Verification Through Fastmail

## Purpose

This document guides the first real-infrastructure verification of the privacy-gateway's native SMTP submission relay through Fastmail. It focuses on proving that a submission can be created, relayed through the gateway, and delivered to a real recipient mailbox via authenticated SMTP.

**Scope**: SMTP outbound relay only (Phases 1–3 of full verification plan).

---

## Prerequisites

### Environment Validation (CRITICAL)

Before proceeding, validate all required Fastmail environment variables:

```bash
cd services/privacy-gateway
./scripts/check-fastmail-env.sh .env.fastmail.local
```

**Exit immediately if validation fails.** All 5 variables must be present and non-placeholder:

- `ALIAS_DOMAIN` — custom domain you own and have configured in Fastmail
- `FASTMAIL_GATEWAY_ADDRESS` — Fastmail account identity (e.g., `you@fastmail.com`)
- `RECIPIENT_MAILBOX_ADDRESS` — test mailbox where you will manually confirm delivery
- `SMTP_PASSWORD` — Fastmail app-specific password (not your account password)
- `DATA_ENCRYPTION_KEY_B64` — 32-byte base64-encoded key (stable across restarts)

### Provider Readiness Checks

Before starting the service:

1. **SMTP Provider Confirmation**
   - Log into Fastmail web interface
   - Verify the SMTP account can send mail
   - Confirm the alias domain is configured and active for outbound relay

2. **Recipient Mailbox Access**
   - Ensure you can access `RECIPIENT_MAILBOX_ADDRESS` manually
   - Verify it is mostly empty so new test messages are easily identifiable

3. **IMAP Mailbox Access** (for full verification later)
   - Test credentials: `IMAP_USERNAME` / `IMAP_PASSWORD` (defaults to gateway identity)
   - Confirm IMAP connection succeeds

---

## Execution: SMTP Relay Verification

### Phase 1: Start Service

**Timestamp**: ___________

**Command**:
```bash
cd services/privacy-gateway
export $(cat .env.fastmail.local | xargs)
go run ./cmd/privacy-gateway/
```

**Expected Output**:
- Service starts on `LISTEN_ADDR` (default `:8080`)
- Data directory created if needed
- No startup errors in logs

**Evidence to Capture** (redact credentials):
```
Startup log excerpt (service starts cleanly):
[CAPTURED: startup timestamp, listen address, initial state]

Env mode summary (SAFE TO LOG):
- DELIVERY_MODE: smtp
- ALIAS_DOMAIN: [REDACTED]
- SMTP_HOST: smtp.fastmail.com
- IMAP_HOST: imap.fastmail.com
```

### Phase 1.1: Health Check

**Timestamp**: ___________

**Request**:
```bash
curl -i http://localhost:8080/healthz
```

**Expected Response**:
```
HTTP/1.1 200 OK
Content-Type: application/json

{"status":"ok"}
```

**Evidence to Capture**:
```json
Health Check Response:
{
  "status": "ok",
  "timestamp": "2026-04-07T12:34:56Z"
}
```

---

### Phase 2: Alias Setup

**Timestamp**: ___________

**Request** — Create a new alias:
```bash
curl -X POST http://localhost:8080/v1/aliases \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{
    "label": "testuser"
  }'
```

**Expected Response** (HTTP 201):
```json
{
  "id": "al_xxx...",
  "label": "testuser",
  "full_address": "testuser-xxxxxxxx@[ALIAS_DOMAIN]",
  "domain": "[ALIAS_DOMAIN]",
  "created_at": "2026-04-07T12:35:00Z"
}
```

**Save the alias ID** — you will need it for the relay phase.

**Evidence to Capture**:
```json
Alias Creation Response:
{
  "id": "al_xxx",
  "label": "testuser",
  "full_address": "testuser-XXXXX@[REDACTED].com",
  "created_at": "ISO8601_TIMESTAMP"
}
```

**Request** — List aliases to confirm:
```bash
curl http://localhost:8080/v1/aliases \
  -H "Authorization: Bearer dev-token"
```

**Expected Response** (HTTP 200):
```json
{
  "aliases": [
    {
      "id": "al_xxx",
      "label": "testuser",
      "full_address": "testuser-XXXXX@[ALIAS_DOMAIN]",
      "inbox_count": 0,
      "created_at": "2026-04-07T12:35:00Z"
    }
  ]
}
```

---

### Phase 3: Native Submission Relay

#### 3.1 Create Submission

**Timestamp**: ___________

**Prepare Test Message A** (outbound plain text):
- **Subject**: `PG SMTP LIVE 1`
- **Body**: `Privacy Gateway SMTP relay test [2026-04-07 12:36:00Z]`
- **To**: The `RECIPIENT_MAILBOX_ADDRESS` (where you will check delivery)

**Request** — Create submission:
```bash
curl -X POST http://localhost:8080/v1/submissions \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{
    "channel_id": "al_xxx",
    "to": ["[RECIPIENT_MAILBOX_ADDRESS]"],
    "subject": "PG SMTP LIVE 1",
    "text_body": "Privacy Gateway SMTP relay test [2026-04-07 12:36:00Z]"
  }'
```

**Expected Response** (HTTP 201):
```json
{
  "id": "sub_xxx",
  "channel_id": "al_xxx",
  "status": "pending",
  "recipients": ["[RECIPIENT_MAILBOX_ADDRESS]"],
  "subject": "PG SMTP LIVE 1",
  "created_at": "2026-04-07T12:36:00Z",
  "relayed_at": null
}
```

**Save the submission ID** (`sub_xxx`) for the relay phase.

**Evidence to Capture**:
```json
Submission Create Response:
{
  "id": "sub_xxx",
  "channel_id": "al_xxx",
  "status": "pending",
  "recipients_count": 1,
  "subject": "PG SMTP LIVE 1",
  "created_at": "ISO8601_TIMESTAMP"
}
```

---

#### 3.2 Relay Submission via SMTP

**Timestamp**: ___________

**Request** — Relay the submission:
```bash
curl -X POST http://localhost:8080/v1/submissions/sub_xxx/relay \
  -H "Authorization: Bearer dev-token"
```

**Expected Response** (HTTP 200):
```json
{
  "id": "sub_xxx",
  "status": "relayed",
  "relayed_at": "2026-04-07T12:36:15Z",
  "relay_attempt_id": "rel_xxx"
}
```

**Critical Observation**: The submission moves from `pending` to `relayed`. The service has accepted the relay request and attempted SMTP delivery to Fastmail's SMTP server.

**Evidence to Capture**:
```json
Submission Relay Response:
{
  "id": "sub_xxx",
  "status": "relayed",
  "relayed_at": "ISO8601_TIMESTAMP",
  "relay_attempt_id": "rel_xxx"
}
```

---

#### 3.3 Verify Submission State

**Timestamp**: ___________

**Request** — Inspect submission detail:
```bash
curl http://localhost:8080/v1/submissions/sub_xxx \
  -H "Authorization: Bearer dev-token"
```

**Expected Response** (HTTP 200):
```json
{
  "id": "sub_xxx",
  "channel_id": "al_xxx",
  "status": "relayed",
  "relayed_at": "2026-04-07T12:36:15Z",
  "recipients": ["[RECIPIENT_MAILBOX_ADDRESS]"],
  "subject": "PG SMTP LIVE 1",
  "text_body": "Privacy Gateway SMTP relay test [2026-04-07 12:36:00Z]",
  "created_at": "2026-04-07T12:36:00Z"
}
```

**Evidence to Capture**:
```json
Submission Detail (after relay):
{
  "id": "sub_xxx",
  "status": "relayed",
  "relayed_at": "ISO8601_TIMESTAMP",
  "recipients_count": 1,
  "subject": "PG SMTP LIVE 1"
}
```

---

#### 3.4 Check Real Recipient Mailbox (Manual Verification)

**Timestamp**: ___________

**Step 1**: Log into Fastmail or your mail client.

**Step 2**: Open the `RECIPIENT_MAILBOX_ADDRESS` mailbox.

**Step 3**: Look for an incoming message with:
- **From**: An address matching the alias pattern (e.g., `testuser-XXXXX@[ALIAS_DOMAIN]`)
- **Subject**: `PG SMTP LIVE 1`
- **Body**: Contains `Privacy Gateway SMTP relay test [2026-04-07 12:36:00Z]`
- **Arrival Time**: Within 30 seconds of the relay request

**Success Criteria**:
- ✓ Message appears in recipient mailbox
- ✓ Sender domain matches `ALIAS_DOMAIN`
- ✓ Subject and body intact
- ✓ Arrival timestamp aligns with relay request

**Evidence to Capture** (screenshot or manual note):
```
Mailbox Verification — RECIPIENT_MAILBOX_ADDRESS
- Message Subject: PG SMTP LIVE 1
- From: testuser-XXXXX@[ALIAS_DOMAIN]
- Arrival Time: 2026-04-07 12:36:20Z
- Status: ✓ RECEIVED
- Notes: Message delivered successfully, no signs of rejection or spam filtering.
```

---

## Result Summary

### SMTP Relay Verification: PASS / FAIL

**Pass Criteria**:
- ✓ Health check returns 200 OK
- ✓ Alias created with expected domain
- ✓ Submission created and accepted (HTTP 201)
- ✓ Relay action returns 200 and moves submission to `relayed`
- ✓ Real recipient mailbox receives the message
- ✓ Sender domain matches configured `ALIAS_DOMAIN`
- ✓ No credential leaks in captured evidence

**Fail Criteria** (choose one):
- ✗ Relay returns non-200 status or error message
- ✗ Recipient mailbox receives nothing within 5 minutes
- ✗ Message arrives but sender domain is incorrect
- ✗ Service crashes or logs credentials

---

## Evidence Checklist

Before concluding, ensure you have captured:

- [ ] Service startup logs (redacted)
- [ ] Environment mode summary (DELIVERY_MODE=smtp, hosts, domains)
- [ ] Health check response
- [ ] Alias creation response
- [ ] Alias list response
- [ ] Submission create response
- [ ] Submission relay response
- [ ] Submission detail (after relay)
- [ ] Real recipient mailbox screenshot or manual note
- [ ] Timestamps aligned across all requests
- [ ] **NO PASSWORDS, APP TOKENS, OR ENCRYPTION KEYS** logged anywhere

---

## Common Issues and Troubleshooting

### Issue: Relay returns 200 but mailbox receives nothing after 5 minutes

**Possible causes**:
1. SMTP credentials rejected silently by Fastmail (test credentials separately)
2. Sender domain (`ALIAS_DOMAIN`) not authorized in Fastmail for relay
3. Message caught in Fastmail spam filter (check spam folder)
4. Recipient mailbox address typo

**Mitigation**:
- Verify SMTP credentials outside the app using `telnet smtp.fastmail.com 587`
- Confirm alias domain is active in Fastmail settings
- Check Fastmail bounce/reject logs

### Issue: Relay returns error like "SMTP: 550 Invalid sender domain"

**Possible causes**:
1. `ALIAS_DOMAIN` not configured in Fastmail
2. Fastmail account does not own the domain for relay

**Mitigation**:
- Verify domain is added to Fastmail account under Settings > Email > Sending Identities
- Ensure the domain's DNS is correctly pointed to Fastmail

### Issue: Service crashes or logs encryption key

**Action**: Stop immediately, do not commit logs. This is a credential leak.

---

## Next Steps After Completion

If SMTP relay verification passes:

1. **Document result** in a separate report following `LIVE-VERIFICATION-REPORT-TEMPLATE.md`
2. **Optional**: Continue with full verification (IMAP sync, restart persistence, etc.) — see `LIVE-VERIFICATION-PLAN.md`
3. **Archive evidence** in the release notes or operational record for the build

---

## Appendix: Environment Configuration Reference

**Required Variables** (from `.env.fastmail.local`):

```bash
# Core relay identity
ALIAS_DOMAIN=yourdomain.com
FASTMAIL_GATEWAY_ADDRESS=you@fastmail.com
RECIPIENT_MAILBOX_ADDRESS=test@yourdomain.com
SMTP_PASSWORD=your-fastmail-app-password

# Encryption (stable across restarts)
DATA_ENCRYPTION_KEY_B64=<base64-32-byte-key>

# Delivery mode (must be 'smtp' for live verification)
DELIVERY_MODE=smtp

# Service binding
LISTEN_ADDR=:8080
DATA_DIR=./data

# Fastmail SMTP config (defaults shown)
SMTP_HOST=smtp.fastmail.com
SMTP_PORT=587
SMTP_USERNAME=${FASTMAIL_GATEWAY_ADDRESS}
SMTP_HELLO_DOMAIN=${ALIAS_DOMAIN}
SMTP_REQUIRE_STARTTLS=true
SMTP_CONNECT_TIMEOUT_SECONDS=10
```

**Test Identity** (from `.env.fastmail.local`):

```bash
DEV_API_TOKEN=dev-token
DEV_USER_ID=user-dev
DEV_TENANT_ID=tenant-dev
DEV_USER_EMAIL=${FASTMAIL_GATEWAY_ADDRESS}
```

---

## Document Metadata

- **Version**: 1.0
- **Created**: 2026-04-07
- **Scope**: SMTP relay verification only (Phases 1–3)
- **Status**: Ready for execution once env variables are filled
- **Related**: `LIVE-VERIFICATION-PLAN.md`, `LIVE-VERIFICATION-REPORT-TEMPLATE.md`
