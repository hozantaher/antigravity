# Cross-Service E2E Verification Report

**Date:** 2026-04-03
**Services:** anti-trace-relay + privacy-gateway + MailHog
**Mode:** ATR bridge -> PG intake -> PG SMTP -> MailHog

## Role

This document is reference evidence for the primary near-term release path defined by:

- [ADR-004-primary-delivery-path.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/ADR-004-primary-delivery-path.md)
- [ADR-005-verification-boundary.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/ADR-005-verification-boundary.md)

It should be read as the strongest current proof for the `bridge -> privacy-gateway intake` path.

It is not the canonical definition of product scope or runtime contract.

## Architecture Under Test

```
Submitter
    |
    v
anti-trace-relay (:18093, TLS 1.3)
    | sanitize, identity-separate, seal, schedule, batch drain
    v
bridge (HTTP POST to PG)
    |
    v
privacy-gateway (:8081)
    | intake endpoint, sanitization, store-and-forward
    v
SMTP (MailHog :1025)
```

## Test Results

### Step 1: Submit to anti-trace-relay

```
POST https://localhost:18093/v1/submit
Body: {"recipient":"dest@example.com","subject":"E2E Final","body":"Full cross-service pipeline"}
```

| Result | Value |
|--------|-------|
| Envelope ID | `env_27164db4875a2506bf8b635a` |
| Status | `sealed` |
| Size class | 512 |

### Step 2: Anti-trace-relay pipeline

ATR log confirms full pipeline execution:
```
intake_accepted  -> env_27164db4875a2506bf8b635a
envelope_scheduled (bucketed to 15-min boundary)
bridge_forwarded -> env_27164db4875a2506bf8b635a
```

Audit events: `intake_accepted`, `relay_scheduled`, `relay_completed` (3 events, no content/IP/identity).

### Step 3: Privacy-gateway intake

PG intake timeline confirms submission received:

| Field | Value |
|-------|-------|
| Submission ID | `sub_bf88671f` |
| Status | `sanitized` |
| Intake channel | `secure_web_intake` |
| Content protection | `encrypted_at_rest` |
| Delivery boundary | `internal_store_and_forward` |
| To | `dest@example.com` |
| Subject | `E2E Final` |

### Step 4: Delivery boundary

Intake submissions have `delivery_boundary: internal_store_and_forward`. This is correct by design:
- Intake submissions do NOT auto-relay to SMTP
- Operator must release them for outbound delivery
- This prevents automated exfiltration through the intake pipeline

### Direct SMTP path (separately verified)

Direct `/v1/messages` endpoint with alias does deliver to MailHog SMTP (verified in LOCAL-SMTP-VERIFICATION-REPORT.md).

## What This Report Proves

This report is sufficient evidence for these claims:

- `anti-trace-relay` can accept an authenticated submission and run its intake pipeline
- the bridge path into `privacy-gateway` works end-to-end
- downstream intake/store-and-forward metadata remains coherent
- the cross-service audit and operator surfaces stay usable without leaking content or identity

## What This Report Does Not Prove

This report does not by itself prove:

- that `deaddrop` is the primary release path
- that direct `smtp` is release-gating for this service
- that every advanced anti-analysis mechanism has production-grade evidence
- that the downstream `privacy-gateway` submission was manually released and delivered in this same artifact

Those questions belong to separate artifacts or later verification waves.

## Conclusion

| Check | Result |
|-------|--------|
| ATR intake pipeline (sanitize, seal, schedule) | PASS |
| ATR batch drain + bridge forward | PASS |
| PG intake endpoint accepts bridge submissions | PASS |
| PG submission created with correct metadata | PASS |
| PG store-and-forward boundary enforced | PASS (by design) |
| Audit trail minimal (no content/IP) | PASS |
| Primary bridge release path evidence | PASS |
| Direct SMTP delivery (separate test) | PASS |

**Cross-service primary release path is verified working.**
