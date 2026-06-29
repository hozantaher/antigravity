# Verification Guide

## Role

This document is the active reference map for verification work.

Use it to decide:

- which verification path is active now
- which document to open first
- which verification artifacts are canonical
- which verification artifacts are only provider-specific support

It is not the primary definition of:

- product boundary
- API contract
- runtime operations

For those, prefer:

- [README.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/README.md)
- [MVP.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/MVP.md)
- [API-CONTRACT-FREEZE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/API-CONTRACT-FREEZE.md)
- [OPERATOR-GUIDE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/OPERATOR-GUIDE.md)

## Current Verification Posture

- local verification: `PASS`
- provider-backed verification: `PREPARED`, not yet executed
- release implication: still `NO-GO` until one real provider-backed run passes

## Active Verification Paths

### 1. Local Safe Verification

Use this when you want to validate the service without real provider credentials.

Open in this order:

1. [LOCAL-RECORD-ONLY-RUN.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/LOCAL-RECORD-ONLY-RUN.md)
2. [LOCAL-VERIFICATION-REPORT.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/LOCAL-VERIFICATION-REPORT.md)

Status:

- already completed successfully

### 2. Generic Live Verification

Use this when you want the provider-agnostic verification scope and pass criteria.

Open in this order:

1. [LIVE-VERIFICATION-PLAN.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/LIVE-VERIFICATION-PLAN.md)
2. [PROVIDER-PLAYBOOK.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/PROVIDER-PLAYBOOK.md)
3. [LIVE-VERIFICATION-REPORT-TEMPLATE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/LIVE-VERIFICATION-REPORT-TEMPLATE.md)

Status:

- active reference path

### 3. First Provider Run: Fastmail

Use this when doing the first concrete provider-backed run.

Open in this order:

1. [FASTMAIL-ENV-READINESS-CHECKLIST.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/FASTMAIL-ENV-READINESS-CHECKLIST.md)
2. [FASTMAIL-GO-NO-GO-PREFLIGHT.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/FASTMAIL-GO-NO-GO-PREFLIGHT.md)
3. [FASTMAIL-RUN-SHEET.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/FASTMAIL-RUN-SHEET.md)
4. [FASTMAIL-DRY-RUN-COMMANDS.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/FASTMAIL-DRY-RUN-COMMANDS.md)
5. [LIVE-VERIFICATION-REPORT-TEMPLATE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/LIVE-VERIFICATION-REPORT-TEMPLATE.md)

Optional provider-specific support:

- [FASTMAIL-LIVE-REPORT-DRAFT.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/FASTMAIL-LIVE-REPORT-DRAFT.md)
- [SPRINT-5-EXECUTION-CHECKLIST.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/SPRINT-5-EXECUTION-CHECKLIST.md)

Status:

- prepared, waiting for real provider credentials and execution

Preferred verification note:

- for outbound verification, prefer the native submission flow:
  - `POST /v1/submissions`
  - then `POST /v1/submissions/{id}/relay`
- keep `POST /v1/messages` as legacy compatibility coverage, not the primary product path
- when `INTAKE_API_TOKEN` is available, include intake read-model smoke checks in postcheck:
  - `/v1/intake/dashboard`
  - `/v1/intake/queue`
  - `/v1/intake/submissions/{id}`
  - `/v1/intake/submissions/{id}/timeline`
- `run-live-postcheck.sh` reuses the last artifact path written by `start-live-run.sh` unless `ARTIFACT_DIR` is explicitly set
- `run-live-postcheck.sh`, `verify-read-models.sh`, and `collect-live-evidence.sh` auto-load `./.env.fastmail.local` when present (or custom `ENV_FILE`) and resolve token priority as:
  - `API_TOKEN`
  - then `DEV_API_TOKEN`
  - then `dev-token`

## Canonical Verification Artifacts

These are the main verification truth surfaces:

- [LOCAL-VERIFICATION-REPORT.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/LOCAL-VERIFICATION-REPORT.md)
  - canonical record of local verification outcome
- [LIVE-VERIFICATION-PLAN.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/LIVE-VERIFICATION-PLAN.md)
  - canonical scope for provider-backed verification
- [LIVE-VERIFICATION-REPORT-TEMPLATE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/LIVE-VERIFICATION-REPORT-TEMPLATE.md)
  - canonical reporting structure for live verification

## Reference Verification Artifacts

These are useful, but subordinate:

- [PROVIDER-PLAYBOOK.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/PROVIDER-PLAYBOOK.md)
- [FASTMAIL-RUN-SHEET.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/FASTMAIL-RUN-SHEET.md)
- [FASTMAIL-ENV-READINESS-CHECKLIST.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/FASTMAIL-ENV-READINESS-CHECKLIST.md)
- [FASTMAIL-GO-NO-GO-PREFLIGHT.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/FASTMAIL-GO-NO-GO-PREFLIGHT.md)
- [FASTMAIL-DRY-RUN-COMMANDS.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/FASTMAIL-DRY-RUN-COMMANDS.md)
- [FASTMAIL-LIVE-REPORT-DRAFT.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/FASTMAIL-LIVE-REPORT-DRAFT.md)
- [SPRINT-5-EXECUTION-CHECKLIST.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/SPRINT-5-EXECUTION-CHECKLIST.md)
- [MVP-SMOKE-TEST.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/MVP-SMOKE-TEST.md)
- [LOCAL-SMTP-VERIFICATION-REPORT.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/LOCAL-SMTP-VERIFICATION-REPORT.md)

## Decision Rule

Before creating any new verification document, ask:

1. should this update an existing canonical verification artifact instead
2. is this provider-specific operator support rather than service truth
3. can this stay a reference note instead of becoming a new truth surface

If the answer is yes, prefer updating the existing artifact over creating a new file.
