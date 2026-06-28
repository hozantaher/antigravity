# Development Plan

Last updated: 2026-04-04 (revised 2026-04-04: added autonomous execution routing)

## Purpose

This document is the root planning map for the next stage of development.

It is not the primary source of product truth for any single service.

Use it to answer:

- what the monorepo should optimize for next
- which work belongs on `MVP`, `ADR`, or `POC` tracks
- which services should move first
- what counts as release work versus post-release expansion

If this document conflicts with a service-local canonical surface, prefer the service-local truth.

## Current Position

The repo is now in a materially stronger state than before:

- reverse SpecKit recovery is in a strong state
- service-local canonical surfaces exist across the main services
- stabilization and verification notes are materially more honest
- `privacy-gateway` is the most advanced product surface in the repo

The monorepo is no longer blocked by broad governance chaos.

The main constraint now is sequencing.

## Planning Model

Every meaningful next task should be classified before implementation:

- `MVP-track`
  - already within known product scope
  - should move toward release, adoption, or operational usefulness
- `ADR-track`
  - blocked by a durable decision
  - should produce a stable architectural or product rule
- `POC-track`
  - blocked by uncertainty
  - should reduce risk before product truth expands

Do not jump directly from idea to implementation when uncertainty is still high.

## Overall Development Goal

The next phase of development should do three things:

1. turn `privacy-gateway` from strong local product into credible release candidate
2. keep the rest of the monorepo stable, legible, and cheap to work in
3. avoid broadening product scope faster than verification and operating confidence

## Priority Order

### Priority 1: Privacy Gateway Release Track

Status:

- highest priority

Reason:

- it is the closest thing in the repo to a release-track product
- most other work should not dilute the release path unless it materially improves it

Focus:

- provider-backed verification
- live evidence capture
- RC recheck
- formal hardening closure

Track classification:

- `MVP-track`

Immediate tasks:

1. run the first real provider-backed native submission relay verification
2. run the first real provider-backed IMAP verification
3. collect native submission, inbox, channel, and timeline evidence
4. write the live verification report
5. re-evaluate the RC decision boundary
6. close the remaining hardening work from live evidence

### Priority 2: Privacy Gateway Post-RC Product Work

Status:

- second priority, only after the release-track decision is settled

Reason:

- the service already has rich local tooling
- more local product work is useful, but no longer the best blocker-removal path

Likely tracks:

- mixed `MVP-track`, `ADR-track`, and `POC-track`

Candidate themes:

- provider lifecycle and delivery diagnostics
- richer inbound coherence only where it clearly improves operator decisions
- retention closure where it materially improves governance
- light UI/operator improvements that remove real workflow friction

Do not use this phase to restart uncontrolled surface expansion.

### Priority 3: Anti-Trace-Relay Product Clarification

Status:

- high, after the `privacy-gateway` release decision is clear

Reason:

- it is strategically adjacent to `privacy-gateway`
- it has better documentation and test posture now, but less product closure

Recommended first move:

- write a short service-local development plan that distinguishes:
  - active MVP path
  - ADR-needed decisions
  - POC-only ideas

Likely tracks:

- `ADR-track` first
- then selective `MVP-track`

### Priority 4: Outreach Stack Maturity

Services:

- [services/machinery-outreach](/Users/messingtomas/Taher/hozan-taher/services/machinery-outreach)
- [services/outreach-dashboard](/Users/messingtomas/Taher/hozan-taher/services/outreach-dashboard)

Status:

- medium

Reason:

- stabilization work succeeded
- but product direction and release posture are still looser than in `privacy-gateway`

Recommended first move:

- define the current delivery goal for the outreach stack
- decide whether the next phase is:
  - operational hardening
  - dashboard completion
  - data/validation improvement

Likely tracks:

- `ADR-track` for system boundary decisions
- `MVP-track` once the delivery goal is explicit

### Priority 5: Tooling Services As Stable Infrastructure

Services:

- [services/garaaage-mcp](/Users/messingtomas/Taher/hozan-taher/services/garaaage-mcp)
- [services/garaaage-worker](/Users/messingtomas/Taher/hozan-taher/services/garaaage-worker)
- [services/garaaage-scrapers](/Users/messingtomas/Taher/hozan-taher/services/garaaage-scrapers)
- [services/garaaage-extension](/Users/messingtomas/Taher/hozan-taher/services/garaaage-extension)

Status:

- medium to low, depending on operational need

Reason:

- these are now much easier to onboard into
- but they should not steal focus from the main release-track service unless they are blocked

Recommended operating rule:

- keep them stable
- only deepen them when directly needed by a real workflow or product milestone

Likely tracks:

- mostly `MVP-track` for maintenance and targeted improvements
- `POC-track` when new integrations or automation experiments are proposed

## Phase Plan

### Phase A: Release Confidence

Goal:

- turn `privacy-gateway` from local `NO-GO` to evidence-backed RC decision

Success condition:

- one real provider-backed verification run is complete
- evidence is captured
- RC status is re-evaluated honestly

### Phase B: Product Tightening

Goal:

- take whichever service is next-most strategic and tighten its scope, decisions, and verification path

Preferred target:

- `anti-trace-relay`

Success condition:

- the target service has a clear `MVP/ADR/POC` map
- next work is no longer ambiguous

### Phase C: Stack Maturity

Goal:

- make the outreach and tooling services cheap to maintain and easy to extend

Success condition:

- each active service has:
  - a current delivery goal
  - an honest verification posture
  - a bounded next backlog

## What Not To Do

Avoid these patterns in the next development phase:

- broad new top-level docs without a local canonical need
- feature work that skips `MVP/ADR/POC` classification
- parallel product expansion across too many services at once
- new operator/UI surfaces that do not remove a real workflow bottleneck
- speculative anonymity claims or scope inflation around privacy systems

## Immediate Next Sequence

Use this order:

1. finish `privacy-gateway` provider-backed verification
2. write the live verification result
3. make the RC decision
4. close the remaining hardening/status loop for `privacy-gateway`
5. start `anti-trace-relay` service-local development planning
6. only then choose the next outreach or tooling push

## Decision Rule

Before starting the next meaningful task, ask:

1. does it move a current release or delivery milestone forward
2. is it clearly `MVP`, `ADR`, or `POC`
3. does it belong to the currently prioritized service

If the answer is not clearly yes, defer it.

## Autonomous Execution

The full autonomous workflow is documented in [tasks/WORKFLOW.md](tasks/WORKFLOW.md).

30 atomic task files are ready for dispatch in [tasks/](tasks/).

Dispatch scripts: `tasks/dispatch.sh`, `tasks/dispatch-batch.sh`, `tasks/review.sh`.

## Related Documents

- [README.md](/Users/messingtomas/Taher/hozan-taher/README.md)
- [MVP-ADR-POC-RULES.md](/Users/messingtomas/Taher/hozan-taher/MVP-ADR-POC-RULES.md)
- [MONOREPO-STABILIZATION-PLAYBOOK.md](/Users/messingtomas/Taher/hozan-taher/MONOREPO-STABILIZATION-PLAYBOOK.md)
- [SPECKIT-RECOVERY-MEMO.md](/Users/messingtomas/Taher/hozan-taher/SPECKIT-RECOVERY-MEMO.md)
- [features/compliance/privacy-gateway/CURRENT-STATUS.md](/Users/messingtomas/Taher/hozan-taher/features/compliance/privacy-gateway/CURRENT-STATUS.md)
- [features/compliance/privacy-gateway/ROADMAP-NEXT.md](/Users/messingtomas/Taher/hozan-taher/features/compliance/privacy-gateway/ROADMAP-NEXT.md)
