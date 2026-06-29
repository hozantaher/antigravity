# Release Candidate Decision Report

**Date**: 2026-04-07
**Decision**: **NO-GO**
**Status**: Awaiting provider-backed verification

---

## Executive Summary

The privacy-gateway MVP is architecturally complete and locally verified, but cannot proceed to release candidate without successful provider-backed verification. This is not a product-scope issue—it is a release-confidence gate.

The decision rule (ADR-004) is explicit:
- **Local verification alone** does not qualify for GO
- **One successful provider-backed verification run** is required before first RC can be GO

---

## Evaluation Against Release Gates

### Gate 1: SMTP Provider-Backed Verification
**Status**: ❌ NOT STARTED
**Evidence**: None yet
**Requirement**: One successful SMTP submission relay through Fastmail must complete end-to-end

**Plan**: Execute `./scripts/fastmail-live-assist.sh ./.env.fastmail.local` following LIVE-SMTP-VERIFICATION.md

---

### Gate 2: IMAP Provider-Backed Verification
**Status**: ❌ NOT STARTED
**Evidence**: None yet
**Requirement**: Inbox sync and message retrieval through Fastmail IMAP must complete successfully

**Plan**: Execute IMAP sync verification following LIVE-VERIFICATION-PLAN.md

---

### Gate 3: Privacy-First Read-Model Validation
**Status**: ❌ NOT STARTED
**Evidence**: None yet
**Requirement**: Channel timeline and inbox read models must maintain operator-first behavior under live provider conditions

**Plan**: Verify no metadata leakage or timeline collapse during provider-backed run

---

### Gate 4: Live Verification Evidence Recording
**Status**: ❌ NOT RECORDED
**Evidence**: No artifacts captured
**Requirement**: Results must be written to canonical verification artifacts

**Plan**: Run `./scripts/collect-live-evidence.sh` after successful provider-backed run

---

### Gate 5: API Contract Integrity
**Status**: ✅ PASSED
**Evidence**: API-CONTRACT-FREEZE.md defined; no changes during development
**Requirement**: Release work must not introduce breaking changes to frozen MVP contract

**Notes**: MVP scope locked. No contract violations observed.

---

### Gate 6: Security Posture
**Status**: ⚠️ LOCAL PASS, LIVE UNKNOWN
**Evidence**:
- Local tests: PASS
- No credentials in logs: VERIFIED
- No open-relay behavior observed locally: VERIFIED
- Real provider interaction: NOT TESTED YET

**Plan**: Monitor for credential leaks and relay abuse during provider-backed run

---

## What Is Already True

The following conditions are **already satisfied** (from CURRENT-STATUS.md, RC-DECISION-MEMO.md):

| Criterion | Status | Evidence |
|-----------|--------|----------|
| MVP scope defined | ✅ | MVP.md exists |
| MVP backlog cut | ✅ | SPRINT-6-CLOSURE-CHECKLIST.md |
| API contract frozen | ✅ | API-CONTRACT-FREEZE.md |
| Local record-only verification | ✅ | CURRENT-STATUS.md: "local verification: PASS" |
| Alias flow verified locally | ✅ | Local tests pass |
| Outbound flow verified locally | ✅ | Submission creation and relay tested |
| Persistence and restart tested locally | ✅ | Data directory encrypted, survives restart |
| Operator guide exists | ✅ | OPERATOR-GUIDE.md |
| Verification plan exists | ✅ | LIVE-VERIFICATION-PLAN.md, LIVE-SMTP-VERIFICATION.md |
| Provider playbook exists | ✅ | scripts/fastmail-live-assist.sh |

---

## What Is Not Blocked

The following do **not** block the first release candidate (ADR-004):

- File-backed persistence (not database-backed)
- Metadata-only attachment handling
- No quarantine workflow
- No admin UI
- No POP3 support
- No advanced MIME reconstruction
- No claim of perfect anonymity
- Optional UI polish

These are accepted MVP scope limits, not RC blockers.

---

## What Does Block RC

Explicit blockers (from ADR-004):

1. **SMTP relay cannot complete in real provider-backed environment** → Would block
2. **IMAP sync cannot complete in real provider-backed environment** → Would block
3. **Timeline/channel read models break under live conditions** → Would block
4. **Live verification reveals open-relay or critical security flaw** → Would block
5. **Release work changes the frozen MVP contract** → Would block
6. **Live verification evidence is missing or too weak** → Would block

**Current Status**: None of these blockers have been triggered because live verification has not been executed yet.

---

## Remaining Work Breakdown

| Phase | Owner | Timeline | Blocker? |
|-------|-------|----------|----------|
| Run SMTP provider-backed verification | Required | Next | YES |
| Capture SMTP evidence | Required | Immediately after | YES |
| Run IMAP provider-backed verification | Required | After SMTP | YES |
| Capture IMAP evidence | Required | Immediately after | YES |
| Validate read-model behavior | Required | During live run | YES |
| Review security posture | Required | Parallel | YES |
| Update RC decision document | Required | Immediately after | NO |
| Document accepted MVP limitations | Optional | After GO | NO |
| Archive release notes | Optional | After GO | NO |

---

## Local Backend Completeness

Per CURRENT-STATUS.md: **90–92% of local backend is complete**
Remaining work estimate: **25–35%** to first strong RC

Concentration of remaining work:
- Provider-backed verification execution and evidence capture
- Live evidence recording
- RC decision refresh based on provider results

---

## Recommended Next Sequence

**Sequence from CURRENT-STATUS.md** (to be executed immediately):

1. **Run first real provider-backed SMTP verification**
   ```bash
   cd services/privacy-gateway
   ./scripts/fastmail-live-assist.sh ./.env.fastmail.local
   ```
   Follow: LIVE-SMTP-VERIFICATION.md for execution and evidence capture

2. **Record the live SMTP verification result**
   - Capture all evidence from execution log
   - Redact credentials
   - Archive screenshots/logs

3. **Run IMAP provider-backed verification** (if SMTP passes)
   - Follow: LIVE-VERIFICATION-PLAN.md
   - Validate inbox sync, timeline integrity, privacy assumptions

4. **Re-evaluate release-candidate status**
   - If all provider-backed gates pass: Update this document to GO
   - If any gate fails: Document failure mode and root cause

5. **Formally close Sprint 6** (SPRINT-6-CLOSURE-CHECKLIST.md)

6. **Treat further local UI or operator polish as optional** (not a release blocker)

---

## Decision Authority

This decision is governed by:
- ADR-004: Release-Candidate Decision Boundary (accepted 2026-04-04)
- RC-DECISION-MEMO.md
- RC-CHECKLIST-SNAPSHOT.md
- MVP-RELEASE-CHECKLIST.md

The rule is unambiguous:
- **Local pass + provider pass = GO**
- **Anything else = NO-GO**

---

## Approval & Signature

- **Decision Made**: 2026-04-07
- **Decision Maker**: Release Verification Gate
- **Next Review**: After provider-backed verification execution
- **Last Updated**: 2026-04-07T00:51Z

---

## Appendix: Verification Artifacts

### Mandatory Evidence Documents

When provider-backed verification is executed, the following must be captured:

1. **LIVE-SMTP-VERIFICATION-REPORT.md**
   - Health check logs
   - Alias creation evidence
   - Submission creation evidence
   - Relay success and mailbox delivery confirmation

2. **LIVE-IMAP-VERIFICATION-REPORT.md**
   - Inbox sync logs
   - Timeline integrity validation
   - Read-model behavior under provider conditions

3. **LIVE-SECURITY-AUDIT.md**
   - No credentials leaked
   - No relay abuse detected
   - No timeline metadata exposure

### Supporting References

- CURRENT-STATUS.md (project snapshot)
- RC-DECISION-MEMO.md (simple decision rule)
- RC-CHECKLIST-SNAPSHOT.md (gate checklist)
- MVP-RELEASE-CHECKLIST.md (MVP scope lock)
- VERIFICATION-GUIDE.md (verification methodology)
- LIVE-SMTP-VERIFICATION.md (SMTP execution guide)
- LIVE-VERIFICATION-PLAN.md (full verification sequence)
- ADR-004 (decision boundary rule)
- ADR-005 (persistence model assumptions)

---

## Footer

This document will be updated immediately after provider-backed verification results are available. Until then, decision remains **NO-GO** and release is blocked on external verification, not internal scope or architecture.

If provider-backed verification gates all pass, this document will be updated to **GO** with the actual verification evidence cited in each section.
