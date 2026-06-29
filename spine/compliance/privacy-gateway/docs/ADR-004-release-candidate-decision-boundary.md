# ADR-004: Release-Candidate Decision Boundary

- **Status:** Accepted
- **Date:** 2026-04-04

## Context

`privacy-gateway` is now in a strong local state:

- local verification passed
- the public HTTP contract is largely frozen
- operator and intake surfaces are in place
- queue/release lifecycle and compat role are now explicitly decided

The remaining ambiguity is not product scope.
It is release judgment.

Today the repository already contains release-oriented artifacts:

- [RC-DECISION-MEMO.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RC-DECISION-MEMO.md)
- [RC-CHECKLIST-SNAPSHOT.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RC-CHECKLIST-SNAPSHOT.md)
- [MVP-RELEASE-CHECKLIST.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/MVP-RELEASE-CHECKLIST.md)
- [VERIFICATION-GUIDE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/VERIFICATION-GUIDE.md)

But until now the actual `GO / NO-GO` rule was documented as release support material, not as an accepted architectural/operational decision.

## Decision

The first release candidate is governed by a strict rule:

- local verification alone is **not** enough for `GO`
- one successful provider-backed verification run is required before the first release candidate can become `GO`

### Current default posture

The default posture remains:

- `NO-GO`

until the provider-backed gate is satisfied.

### Minimum `GO` boundary

The first release candidate becomes `GO` only when all of the following are true:

1. one real SMTP provider-backed verification run passes
2. one real IMAP provider-backed verification run passes
3. privacy-first read-model checks pass during the same live verification cycle
4. the live verification outcome is recorded in the canonical verification artifacts
5. no critical security issue is exposed during the live run
6. no MVP-contract-breaking change is introduced during release hardening

If any of those conditions fail or remain unknown, release posture stays `NO-GO`.

## What Does Not Block RC

The following do not block the first release candidate by themselves:

- file-backed persistence rather than database-backed persistence
- metadata-only attachment handling
- no quarantine workflow
- no admin UI
- no POP3 support
- no advanced MIME reconstruction
- no claim of perfect or untraceable anonymity
- optional additional local UI polish

These are accepted scope limits, not RC blockers.

## What Does Block RC

The following are explicit blockers:

- SMTP cannot complete in a real provider-backed environment
- IMAP sync cannot complete in a real provider-backed environment
- live verification breaks the privacy-first operator/read-model assumptions
- live verification reveals open-relay behavior or a comparable critical security flaw
- release work changes the frozen MVP contract
- live evidence is missing or too weak to support the decision

## Verification Boundary

The release boundary deliberately distinguishes:

- `local confidence`
- `release confidence`

Local confidence means:

- architecture is strong locally
- tests are green
- local `record-only` and shell/operator flows are usable

Release confidence means:

- the system also behaves correctly against a real provider-backed SMTP/IMAP environment

The first release candidate requires both.

## Consequences

### Positive

- `GO / NO-GO` is no longer a vague status judgment
- release cannot be declared from local momentum alone
- verification artifacts now support an explicit decision instead of informal interpretation

### Tradeoffs

- release readiness remains blocked by an external dependency
- local completion can continue rising without changing release posture
- the team must resist treating local polish as equivalent to release evidence

## Rejected Alternatives

### 1. Allow first RC based on local verification only

Rejected because:

- the remaining unknown is specifically provider behavior
- the service promises SMTP/IMAP integration, not just local structure

### 2. Require multiple providers before first RC

Rejected for now because:

- the first RC needs honest baseline confidence, not exhaustive provider breadth
- one successful provider-backed cycle is the smallest reasonable gate

### 3. Delay RC until broader post-MVP hardening is complete

Rejected because:

- it would blur release gating with later product ambitions
- the first RC should be blocked only by evidence needed for the frozen MVP promise

## Operational Rule

From this point on:

- status documents may summarize RC posture
- checklists may operationalize the gate
- but the governing rule itself comes from this ADR

If release conditions change later, update this ADR and the supporting RC artifacts together.

## Current Implementation References

- [RC-DECISION-MEMO.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RC-DECISION-MEMO.md)
- [RC-CHECKLIST-SNAPSHOT.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RC-CHECKLIST-SNAPSHOT.md)
- [MVP-RELEASE-CHECKLIST.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/MVP-RELEASE-CHECKLIST.md)
- [VERIFICATION-GUIDE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/VERIFICATION-GUIDE.md)
