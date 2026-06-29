# Privacy Gateway SpecKit Doc Map

## Purpose

This document classifies the top-level documentation surface of the service into:

- canonical
- reference
- working plan
- archive candidate

Use it when deciding:

- which document defines current truth
- which document is only helpful context
- which document should be read first
- which document should eventually be folded or archived

## Rules

If two documents disagree, prefer them in this order:

1. [README.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/README.md)
2. [MVP.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/MVP.md)
3. [POC-BACKLOG.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/POC-BACKLOG.md)
4. [API-CONTRACT-FREEZE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/API-CONTRACT-FREEZE.md)
5. [docs/ADR-002-store-and-forward-release-policy.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/docs/ADR-002-store-and-forward-release-policy.md)
6. [docs/ADR-003-compat-layer-retirement.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/docs/ADR-003-compat-layer-retirement.md)
7. [docs/ADR-004-release-candidate-decision-boundary.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/docs/ADR-004-release-candidate-decision-boundary.md)
8. [docs/ADR-005-persistence-model.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/docs/ADR-005-persistence-model.md)
9. [docs/ADR-006-secret-management.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/docs/ADR-006-secret-management.md)
10. [OPERATOR-GUIDE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/OPERATOR-GUIDE.md)
11. [CHANGELOG.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/CHANGELOG.md)

Everything else is subordinate to that chain unless explicitly promoted later.

## Canonical

These define active service truth.

### Root Canonical Chain

- [README.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/README.md)
  - service identity and canonical map
- [MVP.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/MVP.md)
  - product boundary
- [POC-BACKLOG.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/POC-BACKLOG.md)
  - explicit experiment and uncertainty backlog
- [API-CONTRACT-FREEZE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/API-CONTRACT-FREEZE.md)
  - public HTTP contract
- [docs/ADR-002-store-and-forward-release-policy.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/docs/ADR-002-store-and-forward-release-policy.md)
  - queue/release lifecycle decision
- [docs/ADR-003-compat-layer-retirement.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/docs/ADR-003-compat-layer-retirement.md)
  - legacy compatibility retirement decision
- [docs/ADR-004-release-candidate-decision-boundary.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/docs/ADR-004-release-candidate-decision-boundary.md)
  - first release-candidate decision rule
- [docs/ADR-005-persistence-model.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/docs/ADR-005-persistence-model.md)
  - persistence evolution and migration triggers
- [docs/ADR-006-secret-management.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/docs/ADR-006-secret-management.md)
  - secret-management evolution and migration triggers
- [OPERATOR-GUIDE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/OPERATOR-GUIDE.md)
  - runtime and deployment truth
- [CHANGELOG.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/CHANGELOG.md)
  - release history

### Canonical Supporting Contracts

These are canonical for specific subdomains, but not above the root chain:

- [SUBMISSIONS-CONTRACT-FREEZE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/SUBMISSIONS-CONTRACT-FREEZE.md)
- [AUDIT-CONTRACT-FREEZE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/AUDIT-CONTRACT-FREEZE.md)
- [IDENTITY-LINKS-CONTRACT-FREEZE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/IDENTITY-LINKS-CONTRACT-FREEZE.md)
- [RELAY-ATTEMPTS-CONTRACT-FREEZE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RELAY-ATTEMPTS-CONTRACT-FREEZE.md)
- [ARCHITECTURE-BOUNDED-CONTEXTS.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/ARCHITECTURE-BOUNDED-CONTEXTS.md)
- [DEPLOYMENT-MODES.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/DEPLOYMENT-MODES.md)
- [docs/ADR-002-store-and-forward-release-policy.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/docs/ADR-002-store-and-forward-release-policy.md)
- [docs/ADR-003-compat-layer-retirement.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/docs/ADR-003-compat-layer-retirement.md)
- [docs/ADR-004-release-candidate-decision-boundary.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/docs/ADR-004-release-candidate-decision-boundary.md)
- [docs/ADR-005-persistence-model.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/docs/ADR-005-persistence-model.md)
- [docs/ADR-006-secret-management.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/docs/ADR-006-secret-management.md)
- [docs/ADR-INDEX.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/docs/ADR-INDEX.md)

## Reference

These are useful but should not be treated as the first source of truth.

### Navigation And Operator Reference

- [RELEASE-ARTIFACT-INDEX.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RELEASE-ARTIFACT-INDEX.md)
- [CURRENT-STATUS.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/CURRENT-STATUS.md)
- [RELEASE-TRACK-MEMO.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RELEASE-TRACK-MEMO.md)
- [OPERATOR-QUERY-COOKBOOK.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/OPERATOR-QUERY-COOKBOOK.md)
- [API-ERROR-CATALOG.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/API-ERROR-CATALOG.md)
- [STATE-FILES-REFERENCE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/STATE-FILES-REFERENCE.md)
- [TENANT-ISOLATION-NOTES.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/TENANT-ISOLATION-NOTES.md)
- [DATA-RETENTION-NOTES.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/DATA-RETENTION-NOTES.md)
- [RETENTION-CONFIGURATION-COOKBOOK.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RETENTION-CONFIGURATION-COOKBOOK.md)
- [ENV-PROFILES.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/ENV-PROFILES.md)

### Verification Reference

- [VERIFICATION-GUIDE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/VERIFICATION-GUIDE.md)
- [POC-BACKLOG.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/POC-BACKLOG.md)
- [MVP-SMOKE-TEST.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/MVP-SMOKE-TEST.md)
- [LOCAL-RECORD-ONLY-RUN.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/LOCAL-RECORD-ONLY-RUN.md)
- [LOCAL-VERIFICATION-REPORT.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/LOCAL-VERIFICATION-REPORT.md)
- [LOCAL-SMTP-VERIFICATION-REPORT.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/LOCAL-SMTP-VERIFICATION-REPORT.md)
- [LIVE-VERIFICATION-PLAN.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/LIVE-VERIFICATION-PLAN.md)
- [PROVIDER-PLAYBOOK.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/PROVIDER-PLAYBOOK.md)
- [FASTMAIL-RUN-SHEET.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/FASTMAIL-RUN-SHEET.md)
- [FASTMAIL-ENV-READINESS-CHECKLIST.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/FASTMAIL-ENV-READINESS-CHECKLIST.md)
- [FASTMAIL-DRY-RUN-COMMANDS.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/FASTMAIL-DRY-RUN-COMMANDS.md)
- [FASTMAIL-GO-NO-GO-PREFLIGHT.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/FASTMAIL-GO-NO-GO-PREFLIGHT.md)
- [LIVE-VERIFICATION-REPORT-TEMPLATE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/LIVE-VERIFICATION-REPORT-TEMPLATE.md)
- [FASTMAIL-LIVE-REPORT-DRAFT.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/FASTMAIL-LIVE-REPORT-DRAFT.md)

### Release Decision Reference

- [RC-DECISION-MEMO.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RC-DECISION-MEMO.md)
- [RC-CHECKLIST-SNAPSHOT.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RC-CHECKLIST-SNAPSHOT.md)
- [RC-POST-RUN-UPDATE-CHECKLIST.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RC-POST-RUN-UPDATE-CHECKLIST.md)
- [MVP-RELEASE-CHECKLIST.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/MVP-RELEASE-CHECKLIST.md)

## Working Plan

These capture sequencing and execution thinking.

- [SPRINT-PLAN.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/SPRINT-PLAN.md)
- [ROADMAP-NEXT.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/ROADMAP-NEXT.md)
- [MVP-BACKLOG-CUT.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/MVP-BACKLOG-CUT.md)
- [PRIVACY-FIRST-PIVOT-PLAN.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/PRIVACY-FIRST-PIVOT-PLAN.md)
- [PHASE-1-IMPLEMENTATION-BACKLOG.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/PHASE-1-IMPLEMENTATION-BACKLOG.md)
- [SPRINT-5-EXECUTION-CHECKLIST.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/SPRINT-5-EXECUTION-CHECKLIST.md)
- [SPRINT-6-OPERATOR-GOVERNANCE-MEMO.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/SPRINT-6-OPERATOR-GOVERNANCE-MEMO.md)
- [SPRINT-6-CLOSURE-CHECKLIST.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/SPRINT-6-CLOSURE-CHECKLIST.md)
- [SPRINT-7-LOCAL-PLAN.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/SPRINT-7-LOCAL-PLAN.md)

These should stay usable, but they are not canonical service truth.

## Archived Status Snapshots

These are retained as historical reference only.

- [SPRINT-STATUS-REPORT.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/SPRINT-STATUS-REPORT.md)
  - historical detailed sprint snapshot
- [ALL-SPRINTS-OVERVIEW.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/ALL-SPRINTS-OVERVIEW.md)
  - historical multi-sprint narrative snapshot

Current short-form status now lives in:

- [CURRENT-STATUS.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/CURRENT-STATUS.md)

## Not Part Of The Doc Map

These are runtime/config artifacts, not service documentation:

- `.env*`
- `cover.out`
- `Dockerfile`
- `go.mod`
- `railway.toml`
- `scripts/`
- `cmd/`
- `internal/`

## Next Recovery Move

After this document exists, the next recovery step should be:

1. stop expanding archive-candidate docs
2. keep current truth in the canonical chain only
3. keep only one short reference status note for active status reporting
