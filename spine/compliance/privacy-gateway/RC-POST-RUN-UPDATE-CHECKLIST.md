# RC Post-Run Update Checklist

Last updated: 2026-04-04

## Purpose

Use this checklist immediately after finishing the first real provider-backed run.

Goal:

- update RC documents consistently
- avoid contradictory `GO / NO-GO` statements
- close Sprint 6 using one deterministic sequence

## Inputs You Must Have

1. completed [FASTMAIL-LIVE-REPORT-DRAFT.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/FASTMAIL-LIVE-REPORT-DRAFT.md)
2. artifact directory from `metadata.txt`
3. final `PASS/FAIL` values from the run report

Optional accelerator:

- one-command local stability check:
  - `./scripts/run-local-stability-check.sh`
  - `./scripts/run-local-stability-check.sh --strict-rc ./artifacts/<run-dir>`
- quick readiness status:
  - `./scripts/show-rc-readiness.sh`
  - `./scripts/show-rc-readiness.sh ./artifacts/<run-dir>`
- strict readiness status:
  - `./scripts/show-rc-readiness.sh --strict`
  - `./scripts/show-rc-readiness.sh --strict ./artifacts/<run-dir>`
- one-command RC post-run flow:
  - `./scripts/run-rc-postrun-workflow.sh ./artifacts/<run-dir>/live-verification-report.md ./artifacts/<run-dir>`
  - `./scripts/run-rc-postrun-workflow.sh --apply ./artifacts/<run-dir>/live-verification-report.md ./artifacts/<run-dir>`
- artifact set check only:
  - `./scripts/check-live-artifact-set.sh ./artifacts/<run-dir>`
- consistency check only:
  - `./scripts/check-rc-doc-consistency.sh`
- generate [rc-update-summary.md] from the report:
  - `./scripts/prepare-rc-update-summary.sh ./artifacts/<run-dir>/live-verification-report.md`
- generate RC doc draft sync outputs:
  - `./scripts/prepare-rc-doc-sync-draft.sh ./artifacts/<run-dir>/rc-update-summary.md`
- dry-run/apply draft sync into canonical RC docs:
  - `./scripts/apply-rc-doc-sync-draft.sh ./artifacts/<run-dir>`
  - `./scripts/apply-rc-doc-sync-draft.sh --apply ./artifacts/<run-dir>`

## Update Sequence

1. Update [RC-CHECKLIST-SNAPSHOT.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RC-CHECKLIST-SNAPSHOT.md)
   - set `decision` to `GO` only if all gates passed
   - move completed provider-backed items from `Remaining` to `Done`
   - keep any failed gate explicit in `Remaining`

2. Update [RC-DECISION-MEMO.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RC-DECISION-MEMO.md) only if decision changed
   - update `Current Decision`
   - update `Reason` so it references the real run outcome
   - keep release-gate rule unchanged unless architecture policy changed

3. Update [CURRENT-STATUS.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/CURRENT-STATUS.md)
   - mark `Sprint 6` as `DONE` only when RC updates are complete and consistent
   - refresh remaining work estimate if RC moved to `GO`

4. Update [RELEASE-TRACK-MEMO.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RELEASE-TRACK-MEMO.md)
   - align short release judgment with RC snapshot/memo
   - remove stale statement that provider run is still missing when already completed

5. Re-validate doc consistency
  - live artifact set is complete (`./scripts/check-live-artifact-set.sh`)
  - `RC-CHECKLIST-SNAPSHOT.md` decision equals `RC-DECISION-MEMO.md` decision
  - both match `CURRENT-STATUS.md` release position
  - Sprint 6 status matches [SPRINT-6-CLOSURE-CHECKLIST.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/SPRINT-6-CLOSURE-CHECKLIST.md)
  - run `./scripts/check-rc-doc-consistency.sh` and require `PASS`

Note:

- `prepare-rc-doc-sync-draft.sh` generates review-first draft files (`*.next.md`) for:
  - `RC-CHECKLIST-SNAPSHOT.md`
  - `CURRENT-STATUS.md`
  - `RC-DECISION-MEMO.md`
  - `RELEASE-TRACK-MEMO.md`
- it does not overwrite canonical docs automatically.
- `apply-rc-doc-sync-draft.sh` is dry-run by default and creates backups before applying changes.
- `run-rc-postrun-workflow.sh` now validates consistency twice:
  - generated draft docs (always)
  - canonical docs (when `--apply` is used)

## Decision Matrix

- If all gates `PASS`: set `GO`, close Sprint 6.
- If any required gate `FAIL`: keep `NO-GO`, keep Sprint 6 `IN PROGRESS`, record exact blocker.
- If evidence is incomplete: keep `NO-GO` until evidence is completed.

## Definition Of Complete

This checklist is complete only when:

1. RC docs agree on one decision (`GO` or `NO-GO`)
2. decision reason points to real provider-backed evidence
3. Sprint 6 status and closure checklist are aligned
