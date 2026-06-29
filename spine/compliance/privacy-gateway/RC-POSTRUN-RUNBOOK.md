# RC Post-Run Runbook

Last updated: 2026-04-04

## Purpose

This is the shortest operator flow after a completed live provider-backed run.

Use it to move from live artifacts to synchronized RC decision docs.

## Inputs

From [services/privacy-gateway](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway):

- completed `live-verification-report.md`
- artifact directory from `./artifacts/last-run-path.txt`

## Preferred Command Path

Quick status first:

```bash
./scripts/show-rc-readiness.sh
./scripts/show-rc-readiness.sh ./artifacts/<run-dir>
./scripts/run-local-stability-check.sh
./scripts/run-local-stability-check.sh --strict-rc ./artifacts/<run-dir>
```

Dry-run (safe default):

```bash
./scripts/run-rc-postrun-workflow.sh ./artifacts/<run-dir>/live-verification-report.md ./artifacts/<run-dir>
```

Apply (writes canonical RC docs with backups):

```bash
./scripts/run-rc-postrun-workflow.sh --apply ./artifacts/<run-dir>/live-verification-report.md ./artifacts/<run-dir>
```

Strict readiness verification:

```bash
./scripts/show-rc-readiness.sh --strict
./scripts/show-rc-readiness.sh --strict ./artifacts/<run-dir>
```

## What The Workflow Enforces

1. live artifact set completeness
2. RC summary generation (`GO/NO-GO`)
3. draft sync generation for all RC decision docs
4. draft-level decision consistency validation
5. optional canonical apply with backups
6. canonical decision consistency validation

## Files Affected In Apply Mode

- [RC-CHECKLIST-SNAPSHOT.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RC-CHECKLIST-SNAPSHOT.md)
- [CURRENT-STATUS.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/CURRENT-STATUS.md)
- [RC-DECISION-MEMO.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RC-DECISION-MEMO.md)
- [RELEASE-TRACK-MEMO.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RELEASE-TRACK-MEMO.md)

## Exit Rule

- If workflow ends with `PASS` and decision is `GO`, Sprint 6 can be marked `DONE`.
- If decision is `NO-GO`, keep Sprint 6 `IN PROGRESS` and carry blocker lines into next live run.
