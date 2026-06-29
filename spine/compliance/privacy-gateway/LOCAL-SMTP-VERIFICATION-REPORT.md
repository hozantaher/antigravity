# Local SMTP Verification Report

**Date:** 2026-04-03
**Provider:** MailHog (local SMTP sink, port 1025)
**Mode:** SMTP delivery, STARTTLS disabled (local only)
**Gateway:** privacy-gateway on :8081

## Test Results

### Test 1: Direct alias -> message -> SMTP

| Step | Result |
|------|--------|
| Create alias `testuser` | `al_fe3ac396`, email `testuser-fe3ac396@relay.local` |
| Send message via `/v1/messages` | `msg_994b4055` created |
| MailHog received | 1 message |
| From header | `<testuser-fe3ac396@relay.local>` |
| To header | `<recipient@example.com>` |
| Subject | `Live SMTP Test` |
| Body | Plain text delivered correctly |

**Privacy check on delivered message:**
- X-Mailer: ABSENT (pass)
- X-Originating-IP: ABSENT (pass)
- User-Agent: ABSENT (pass)
- X-Forwarded-For: ABSENT (pass)

### Test 2: Intake endpoint submission

| Step | Result |
|------|--------|
| Submit via `POST /v1/intake/submissions` | `sub_3d675a6b` created |
| Status | `sanitized` |
| Intake channel | `secure_web_intake` |
| Metadata profile | `minimized` |
| Content protection | `encrypted_at_rest` |
| Delivery boundary | `internal_store_and_forward` |

### Test 3: Intake read models

| Endpoint | Result |
|----------|--------|
| `GET /v1/intake/status` | `total=2, pending=1, relayed=1, failed=0, blocked=0` |
| `GET /v1/intake/timeline` | 2 entries with correct status, channel, and timestamps |

### Test 4: Full E2E relay

| Step | Result |
|------|--------|
| Create alias `intake-relay` | `al_e00d35e8` |
| Send via alias to SMTP | `msg_c0635992` |
| MailHog total | 2 messages |
| From | `<intake-relay-e00d35e8@relay.local>` |
| Subject | `Intake Relay E2E` |
| Body | Delivered correctly |

### Test 5: Dashboard

| Metric | Value |
|--------|-------|
| Channels | 2 |
| testuser channel | subs=1, inbox=0, relays=1 |
| intake-relay channel | subs=1, inbox=0, relays=1 |

### Test 6: Audit trail

3 audit events generated across the test session.

## Conclusion

- SMTP delivery pipeline: **verified working**
- Alias -> message -> SMTP -> MailHog: **pass**
- Intake endpoint -> submission -> sanitization: **pass**
- Intake read models (status, timeline): **pass**
- Privacy headers absent in delivered messages: **pass**
- Dashboard aggregation: **pass**

## Next Steps

- Sprint 5: repeat against real Fastmail SMTP/IMAP
- Verify IMAP inbound sync (MailHog does not support IMAP)
