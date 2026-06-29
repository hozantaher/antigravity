# Roadmap Next

## Purpose

This is the shortest planning snapshot for what to do next in the project.

This document is a planning reference, not a canonical scope document.

Use it when you need to answer:

- what is still worth doing before the next release candidate decision
- what should wait until after release
- what is explicitly not a current priority

If it conflicts with current service truth, prefer:

- [README.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/README.md)
- [MVP.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/MVP.md)
- [POC-BACKLOG.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/POC-BACKLOG.md)
- [API-CONTRACT-FREEZE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/API-CONTRACT-FREEZE.md)
- [OPERATOR-GUIDE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/OPERATOR-GUIDE.md)

## Current Position

The project is in a strong local state:

- local `record-only` verification: `PASS`
- privacy-first backend foundation: in place
- public API surfaces: documented and largely frozen
- retention posture: now documented and partly enforced
- local secure-intake and queue workflow: in place
- local `/ui` shell: in place for operator, intake, queue, and timeline/detail flows

The main remaining release-level unknown is still provider-backed verification.

## Planning Classification Rule

Before adding a new roadmap item, classify it first:

- `MVP-track`
  - already part of the known product boundary
- `ADR-track`
  - blocked mainly by a durable decision
- `POC-track`
  - blocked mainly by uncertainty

For the current service, use [POC-BACKLOG.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/POC-BACKLOG.md) for open experiment candidates instead of expanding roadmap prose alone.

## Now

These are the highest-value next tasks.

### 1. Provider-Backed Verification

Priority:

- highest

Work:

- run one real SMTP provider-backed verification
- run one real IMAP provider-backed verification
- record the result in the existing verification report

Why now:

- this is the clearest blocker between local confidence and release confidence

### 2. Release-Candidate Recheck

Priority:

- highest, immediately after provider verification

Work:

- re-evaluate [RC-DECISION-MEMO.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RC-DECISION-MEMO.md)
- update [RC-CHECKLIST-SNAPSHOT.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RC-CHECKLIST-SNAPSHOT.md)
- confirm whether the current milestone becomes `GO` or remains `NO-GO`

Why now:

- it closes the current milestone cleanly

### 3. Sprint 6 Formal Closure

Priority:

- high, but after provider verification

Work:

- confirm operator surfaces behaved as documented during the provider-backed run
- refresh sprint status and governance memo
- close [SPRINT-6-CLOSURE-CHECKLIST.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/SPRINT-6-CLOSURE-CHECKLIST.md)

Why next:

- it closes the current hardening cycle cleanly after live evidence exists

### 4. Post-Sprint-7 Local Continuation

Priority:

- medium, only if it does not delay verification

Work:

- optional local UI refinement
- targeted shell improvements only where they reduce real operator friction
- no new local-only surface unless it clearly pays for itself

Why later:

- `Sprint 7` already delivered a useful local shell and intake operator flow
- further local polish is useful for product maturation
- not the current release blocker

## Soon After Release

These are good next themes once the current releaseable milestone is closed.

### Provider Lifecycle And Delivery Diagnostics

Focus:

- bounce and delivery diagnostics
- provider-specific failure handling
- richer live-operational evidence

### Inbound Coherence Extensions

Focus:

- further tighten inbox-to-audit correlation only where it materially improves operator clarity
- improve thread-level interpretation without broadening product scope

### Operator Hardening

Focus:

- final retention review
- log and error-message sensitivity pass
- deployment and governance cleanup

## Later

These are valid future directions, but they are not the best next move today.

- richer MIME handling
- attachment lifecycle improvements
- inbox and outbox age-based retention
- stronger secret-management posture such as external vault or KMS
- database-backed persistence
- provider lifecycle handling such as bounce and delivery diagnostics
- operator/admin surfaces
- broader local UI work

## Not Now

These are intentionally not near-term priorities.

- new top-level product surfaces unrelated to verification
- broad admin UI
- POP3 expansion
- mixnet or anti-trace networking work
- any product claim of perfect or untraceable anonymity

## Practical Decision Rule

Before starting a new task, ask:

1. does it move provider-backed verification forward
2. does it improve release confidence without expanding scope
3. does it naturally follow from the current sprint sequence

If not, it probably belongs after the current releaseable milestone.

## Recommended Immediate Sequence

Use this order:

1. prepare real provider env
2. run assisted provider verification (`./scripts/fastmail-live-assist.sh ./.env.fastmail.local`)
3. write verification report
4. recheck release candidate status
5. close Sprint 6 hardening from the live result

## Cross-References

- [RC-CHECKLIST-SNAPSHOT.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RC-CHECKLIST-SNAPSHOT.md)
- [MVP-BACKLOG-CUT.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/MVP-BACKLOG-CUT.md)
- [SPRINT-PLAN.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/SPRINT-PLAN.md)
- [DEPLOYMENT-MODES.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/DEPLOYMENT-MODES.md)
