# Anti-Trace Relay SpecKit Doc Map

## Purpose

This document classifies the top-level documentation surface of the service into:

- canonical
- reference
- archive candidate

Use it when deciding:

- which files define current truth
- which files are supporting evidence
- which files should stop expanding as primary narratives

## Rules

If documents disagree, prefer them in this order:

1. [README.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/README.md)
2. [ADR.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/ADR.md)
3. [ADR-004-primary-delivery-path.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/ADR-004-primary-delivery-path.md)
4. [ADR-005-verification-boundary.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/ADR-005-verification-boundary.md)
5. [DEPLOYMENT.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/DEPLOYMENT.md)
6. [CHANGELOG.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/CHANGELOG.md)

Everything else is subordinate to that chain unless explicitly promoted later.

## Canonical

These define active service truth.

- [README.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/README.md)
  - service identity, current verification posture, and canonical map
- [ADR.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/ADR.md)
  - primary MVP architecture
- [ADR-004-primary-delivery-path.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/ADR-004-primary-delivery-path.md)
  - primary delivery path and mode hierarchy
- [ADR-005-verification-boundary.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/ADR-005-verification-boundary.md)
  - credible release-track verification boundary
- [DEPLOYMENT.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/DEPLOYMENT.md)
  - deployment and operations
- [CHANGELOG.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/CHANGELOG.md)
  - release and verified milestone record

## Reference

These are useful but should not be treated as the first source of truth.

### Working Plan Reference

- [CURRENT-STATUS.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/CURRENT-STATUS.md)
- [RELEASE-TRACK-MEMO.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/RELEASE-TRACK-MEMO.md)
- [DEVELOPMENT-PLAN.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/DEVELOPMENT-PLAN.md)

### Architecture And Threat Model Reference

- [ADR-002.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/ADR-002.md)
- [ADR-003.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/ADR-003.md)

### Deployment And Usage Reference

- [OPSEC-DEPLOY.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/OPSEC-DEPLOY.md)
- [SUBMITTER-GUIDE.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/SUBMITTER-GUIDE.md)

### Verification Reference

- [LIVE-DEPLOYMENT-REPORT.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/LIVE-DEPLOYMENT-REPORT.md)
- [CROSS-SERVICE-VERIFICATION-REPORT.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/CROSS-SERVICE-VERIFICATION-REPORT.md)

Use the reference set for:

- deeper security context
- operator hardening detail
- proof and evidence of prior runs

Not for:

- redefining current product boundary
- redefining runtime contract

## Archive Candidates

There are no immediate archive candidates yet.

Reason:

- the top-level surface is broader than ideal, but still reasonably role-separable
- the current problem is document role ambiguity, not obvious dead documents

Potential future candidates:

- old verification reports once a stronger recurring verification record exists
- any future duplicate deployment narratives if they appear

## Not Part Of The Doc Map

These are runtime or code artifacts, not service documentation:

- `Dockerfile`
- `go.mod`
- `railway.toml`
- `deploy/`
- `scripts/`
- `cmd/`
- `internal/`

## Next Recovery Move

After this document exists, the next recovery step should be:

1. keep current truth in the canonical chain only
2. keep reports and threat-model expansions in reference role
3. avoid introducing overlapping status narratives at the service root
