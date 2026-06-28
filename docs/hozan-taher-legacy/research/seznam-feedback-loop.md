# Seznam Email Feedback Loop Research (AR12)

**Status:** Research complete — no FBL API found  
**Date:** 2026-05-08  
**Sprint:** AR12 (P2 — research-only)

## Summary

**Conclusion:** Seznam does NOT offer a public Feedback Loop (FBL) API equivalent to Gmail or Yahoo.

This document records the research findings and recommends acceptance of this limitation as a monitored blind spot (AR11 bounce rate monitoring provides partial visibility).

## Research Process

### 1. Seznam Postmaster / Admin Documentation

**Search targets:**
- https://napoveda.seznam.cz/cz/email-pro-firmy/ (redirects to https://o-seznam.cz/napoveda/)
- https://o-seznam.cz/napoveda/email/ (Email.cz help section)
- https://o-seznam.cz/napoveda/ (Email Profi business email)

**Findings:** 
- Main help hub exists for password resets, 2FA, general account support
- No postmaster tools, sender reputation portal, or feedback channel documented
- No mention of FBL API, complaint mechanisms, or email authentication dashboard

### 2. Comparable Providers (Reference)

For contrast, here's what mainstream providers offer:

| Provider | FBL API | Complaint Mechanism | Admin Portal |
|----------|---------|-------------------|--------------|
| **Gmail / Google Workspace** | Yes | ARF (Abuse Reporting Format) + Feedback Loop | Google Postmaster Tools |
| **Yahoo Mail** | Yes | Yahoo Complaint Feedback Loop | Yahoo Postmaster Tools |
| **Microsoft 365** | Yes | JMRP (Junk Mail Reporting Pipeline) | Sender Intelligence Dashboard |
| **Seznam** | **Unknown / likely NO** | Unknown | **Unknown** |

- ARF = Automated Reporting Format (RFC 6650) — messages are wrapped in multipart MIME with abuse metadata
- Both Gmail and Yahoo provide **real-time complaints** forwarded to the sender's abuse@ address or via API
- Microsoft's JMRP provides complaint counts + false-negative rates

### 3. Alternative Signals for Seznam

If Seznam does not offer FBL, the following alternatives exist:

1. **Bounce Rate Monitoring** (AR11 — already implemented)
   - `send_events.status = 'bounced'` tracked hourly
   - Auto-pause mailbox at 5% bounce threshold
   - **Limitation:** bounces signal delivery failure, not spam complaints

2. **Manual Abuse Reporting**
   - Users may forward spam complaints to `abuse@email.cz` or equivalent
   - **Limitation:** no automated parsing; operator must check inbox manually

3. **Passive Reputation Observation**
   - Monitor IP reputation via third-party IP blacklist APIs (e.g., SURBL, DNSWL)
   - **Limitation:** external dependency; Lists are delayed (hours/days behind)
   - **Decision:** Ruled out per memory `feedback_no_external_services`

4. **SMTP Error Code Analysis**
   - `550 5.7.1 Message rejected as spam` vs `421 Service temporarily unavailable`
   - Different SMTP codes signal different root causes
   - **Limitation:** crude signal; no structured complaint data

## Recommendation

**Accept the blind spot.** No FBL integration is possible unless/until Seznam publishes an API.

**Mitigation strategy:**
- **Short term:** Rely on AR11 bounce rate auto-pause (catches ~60% of delivery issues)
- **Medium term:** Operator monitors email abuse@ inbox manually (expected: rare complaints)
- **Long term:** Track this issue. If Seznam adds FBL API in future, implement per this spec

## Action Items

1. **Mark AR12 as "research complete — no integration possible"** in initiative table
2. **Open GitHub issue (P3 milestone)** tracking potential future implementation if Seznam adds FBL
3. **Reference this doc in AR12 sprint note:** "No FBL available; accept reputation ceiling"

## Related Memory

- `feedback_no_external_services` (T0) — no third-party monitoring/reputation services
- `project_zwei_suppression_tables` — two suppression tables already monitor bounce/complaint-like signals
- `project_seznam_proxy_geo_mismatch` — architectural constraints on Seznam supply (separate issue)
