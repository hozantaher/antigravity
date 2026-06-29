# Sprint 6 Closure Checklist

Last updated: 2026-04-04

## Purpose

This is the formal closure gate for `Sprint 6`.

`Sprint 6` can move from `IN PROGRESS` to `DONE` only when every required item below is complete.

## Required Gates

1. Execute one real provider-backed run:
   - SMTP outbound pass
   - IMAP inbound pass
   - privacy-first read-model pass during the same run

2. Capture live evidence artifacts:
   - health, alias, channel, submission, inbox, timeline artifacts
   - optional intake artifacts if `INTAKE_API_TOKEN` is configured

3. Update live verification report artifacts:
   - fill the Fastmail live report draft
   - ensure report chain matches `VERIFICATION-GUIDE.md`

4. Recheck release-candidate decision:
   - update `RC-CHECKLIST-SNAPSHOT.md`
   - update `RC-DECISION-MEMO.md` only if the decision changes

5. Confirm no release-boundary regressions:
   - no API contract expansion during closure pass
   - no critical security issue opened by the live run

## Recommended Execution Path

From [services/privacy-gateway](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway):

```bash
./scripts/fastmail-live-assist.sh ./.env.fastmail.local
```

Then complete report and RC updates:

1. update [FASTMAIL-LIVE-REPORT-DRAFT.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/FASTMAIL-LIVE-REPORT-DRAFT.md)
2. apply [RC-POST-RUN-UPDATE-CHECKLIST.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RC-POST-RUN-UPDATE-CHECKLIST.md)
   - shortest operator path: [RC-POSTRUN-RUNBOOK.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RC-POSTRUN-RUNBOOK.md)
3. if needed, update [RC-DECISION-MEMO.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RC-DECISION-MEMO.md)
4. mark `Sprint 6` as `DONE` in [CURRENT-STATUS.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/CURRENT-STATUS.md)

## Exit Condition

If all gates pass, `Sprint 6` is formally closed.

If any required gate fails, keep `Sprint 6` as `IN PROGRESS` and record the blocker in the live report.
