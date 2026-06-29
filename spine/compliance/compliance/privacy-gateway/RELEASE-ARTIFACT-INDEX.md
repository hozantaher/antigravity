# Privacy Gateway Release Artifact Index

## Purpose

This is the shortest navigation guide for the MVP and release artifact set.

This file is a reference index.

It is not the primary definition of:

- product boundary
- frozen API contract
- operator truth

Those remain in:

- [README.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/README.md)
- [MVP.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/MVP.md)
- [API-CONTRACT-FREEZE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/API-CONTRACT-FREEZE.md)
- [OPERATOR-GUIDE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/OPERATOR-GUIDE.md)

Use it when you want to know:

- what to read first
- which document answers which question
- what to open during local runs or release verification

## Recommended Reading Order

### 1. Product Boundary

Read these first:

- [MVP.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/MVP.md)
- [API-CONTRACT-FREEZE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/API-CONTRACT-FREEZE.md)
- [MVP-BACKLOG-CUT.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/MVP-BACKLOG-CUT.md)

Use these to answer:

- what the product is
- what is frozen for MVP
- what is intentionally not part of the first release

### 2. Release Decision

Read these next:

- [RC-DECISION-MEMO.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RC-DECISION-MEMO.md)
- [RC-CHECKLIST-SNAPSHOT.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RC-CHECKLIST-SNAPSHOT.md)
- [RC-POST-RUN-UPDATE-CHECKLIST.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RC-POST-RUN-UPDATE-CHECKLIST.md)
- [RC-POSTRUN-RUNBOOK.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RC-POSTRUN-RUNBOOK.md)
- [MVP-RELEASE-CHECKLIST.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/MVP-RELEASE-CHECKLIST.md)

Use these to answer:

- are we `GO` or `NO-GO`
- what still blocks release
- what remains after the local MVP pass
- how to update RC artifacts consistently after the live provider-backed run
- what exact command path to run for RC post-run synchronization

### 3. Local Operation

Use these for safe local work:

- [OPERATOR-GUIDE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/OPERATOR-GUIDE.md)
- [ROADMAP-NEXT.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/ROADMAP-NEXT.md)
- [RELAY-ATTEMPTS-CONTRACT-FREEZE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RELAY-ATTEMPTS-CONTRACT-FREEZE.md)
- [OPERATOR-QUERY-COOKBOOK.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/OPERATOR-QUERY-COOKBOOK.md)
- [API-ERROR-CATALOG.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/API-ERROR-CATALOG.md)
- [STATE-FILES-REFERENCE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/STATE-FILES-REFERENCE.md)
- [TENANT-ISOLATION-NOTES.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/TENANT-ISOLATION-NOTES.md)
- [DATA-RETENTION-NOTES.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/DATA-RETENTION-NOTES.md)
- [RETENTION-CONFIGURATION-COOKBOOK.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RETENTION-CONFIGURATION-COOKBOOK.md)
- [ENV-PROFILES.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/ENV-PROFILES.md)
- [DEPLOYMENT-MODES.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/DEPLOYMENT-MODES.md)
- [LOCAL-RECORD-ONLY-RUN.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/LOCAL-RECORD-ONLY-RUN.md)
- [LOCAL-VERIFICATION-REPORT.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/LOCAL-VERIFICATION-REPORT.md)

Use these to answer:

- how to run locally
- what to do next without reopening scope discovery
- which API queries to use during local or operator review
- how relay attempts are exposed and filtered
- which API errors are expected versus suspicious
- what each persisted state file means
- where tenant scope is enforced and why some reads intentionally return `404`
- what is actually retained versus only hidden at read time
- which retention profile to choose for local, shared, or privacy-strict environments
- which ready-made env snippet to copy into a deployment
- which deployment mode to choose before enabling provider-backed transport
- what was already verified locally
- what local mode does and does not prove

### 4. Manual MVP Verification

Use this when doing a manual candidate check:

- [MVP-SMOKE-TEST.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/MVP-SMOKE-TEST.md)

Use it to answer:

- what must be manually exercised for the 3 MVP flows

### 5. Real Provider Verification

Use these when moving from local to provider-backed runs:

- [VERIFICATION-GUIDE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/VERIFICATION-GUIDE.md)
- [LIVE-VERIFICATION-PLAN.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/LIVE-VERIFICATION-PLAN.md)
- [PROVIDER-PLAYBOOK.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/PROVIDER-PLAYBOOK.md)
- [FASTMAIL-RUN-SHEET.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/FASTMAIL-RUN-SHEET.md)
- [FASTMAIL-ENV-READINESS-CHECKLIST.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/FASTMAIL-ENV-READINESS-CHECKLIST.md)
- [FASTMAIL-DRY-RUN-COMMANDS.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/FASTMAIL-DRY-RUN-COMMANDS.md)

Use these to answer:

- which provider to try first
- how to prepare env safely
- how to run SMTP and IMAP verification in practice

### 6. Verification Recording

Use these when recording outcomes:

- [VERIFICATION-GUIDE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/VERIFICATION-GUIDE.md)
- [LIVE-VERIFICATION-REPORT-TEMPLATE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/LIVE-VERIFICATION-REPORT-TEMPLATE.md)
- [FASTMAIL-LIVE-REPORT-DRAFT.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/FASTMAIL-LIVE-REPORT-DRAFT.md)
- [RC-POST-RUN-UPDATE-CHECKLIST.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RC-POST-RUN-UPDATE-CHECKLIST.md)

Use these to answer:

- where to write live results
- how to record the first Fastmail run
- how to propagate run results into consistent RC decision artifacts

## Fastest Paths

### Fastest path to understand the release

Open in this order:

1. [RC-CHECKLIST-SNAPSHOT.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RC-CHECKLIST-SNAPSHOT.md)
2. [RC-DECISION-MEMO.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RC-DECISION-MEMO.md)
3. [MVP-BACKLOG-CUT.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/MVP-BACKLOG-CUT.md)

### Fastest path to run locally

Open in this order:

1. [OPERATOR-GUIDE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/OPERATOR-GUIDE.md)
2. [OPERATOR-QUERY-COOKBOOK.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/OPERATOR-QUERY-COOKBOOK.md)
3. [LOCAL-RECORD-ONLY-RUN.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/LOCAL-RECORD-ONLY-RUN.md)
4. [LOCAL-VERIFICATION-REPORT.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/LOCAL-VERIFICATION-REPORT.md)

### Fastest path to attempt release verification

Open in this order:

1. [VERIFICATION-GUIDE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/VERIFICATION-GUIDE.md)
2. [FASTMAIL-ENV-READINESS-CHECKLIST.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/FASTMAIL-ENV-READINESS-CHECKLIST.md)
3. [FASTMAIL-RUN-SHEET.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/FASTMAIL-RUN-SHEET.md)
4. [FASTMAIL-DRY-RUN-COMMANDS.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/FASTMAIL-DRY-RUN-COMMANDS.md)
5. [LIVE-VERIFICATION-REPORT-TEMPLATE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/LIVE-VERIFICATION-REPORT-TEMPLATE.md)
