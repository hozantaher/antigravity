# Privacy-First Communication Gateway Sprint Plan

## Goal

Build the first releaseable milestone of the privacy-first communication gateway:

- secure submission intake
- tenant-scoped identity separation
- tenant-scoped audit visibility
- controlled relay compatibility
- persistent local runtime suitable for verification and iteration

This plan does not target perfect anonymity.
It targets a credible privacy-first backend foundation.

## Current Baseline

Already done:

- `submissions` create/list/detail
- `audit-events` list with `event_type`, `limit`, `since`, and retention
- `identity-links` create/list
- persistent stores for alias, submission, audit, identity link, inbox, outbox, and IMAP cursor
- compatibility path for legacy `/v1/messages`
- IMAP inbox sync and SMTP relay support
- encrypted-at-rest local storage

Current project shape:

- intake exists
- audit exists
- identity vault exists
- relay exists
- inbox exists
- compatibility mail path still exists

## Sprint 1

### Theme

Stabilize the privacy-first core.

### Objective

Finish the minimum backend foundation so the new product frame is operationally coherent.

### Scope

- freeze the product frame around `privacy-first communication gateway`
- keep `submissions`, `audit-events`, and `identity-links` stable
- close any remaining persistence or validation gaps in these flows
- add concise milestone and sprint documentation

### Done Criteria

- all current privacy-first endpoints are documented and tested
- local persistence survives restart for all current bounded contexts
- project language no longer frames the product as an `anonymous gateway`

### Status

- effectively complete after the current turn

## Sprint 2

### Theme

Alias-scoped vault and lookup precision.

### Objective

Make the identity-vault surface practically usable for app logic, not just listable.

### Scope

- add `GET /v1/identity-links/{alias_id}` or equivalent alias-scoped lookup
- add narrow validation around alias existence or ownership assumptions
- define how expired identity links should behave
- add audit event coverage for identity-link creation

### Done Criteria

- app can fetch the identity link for one alias without listing the whole tenant set
- identity-link lifecycle rules are explicit
- audit trail covers vault writes

## Sprint 3

### Theme

Submission-to-relay lifecycle tightening.

### Objective

Close the gap between intake records and transport state.

### Scope

- richer submission status transitions
- explicit submission-to-relay failure state handling
- relay attempt visibility or summarized status in submission detail
- audit coverage for relay success and failure paths

### Done Criteria

- submission detail is enough to understand whether a message was accepted, sanitized, relayed, or failed
- compatibility `/v1/messages` and native `submissions` flow stay consistent

## Sprint 4

### Theme

Inbound coherence.

### Objective

Connect inbound mail more cleanly to the privacy-first model.

### Scope

- define mapping from inbound message to alias and possibly to submission thread/reference
- tighten inbox/audit relationship
- improve IMAP operational verification against the new product frame

### Done Criteria

- inbound path is no longer “legacy inbox bolted on the side”
- documentation explains how inbox fits the communication gateway model

## Sprint 5

### Theme

Provider-backed release verification.

### Objective

Move from locally strong architecture to externally verified behavior.

### Scope

- one SMTP provider-backed verification run
- one IMAP provider-backed verification run
- write the final verification report
- re-evaluate release candidate status for the privacy-first milestone

### Done Criteria

- local verification: pass
- provider verification: pass
- release memo can move from `NO-GO` to conditional `GO`

## Sprint 6

### Theme

Operator and governance hardening.

### Objective

Prepare the service for more serious internal use without expanding into a full admin platform.

### Scope

- retention review across all bounded contexts
- operator-facing runbook cleanup
- sensitive data review in logs and error messages
- contract freeze refresh across submission, audit, and identity-link APIs

### Done Criteria

- operator docs match runtime
- retention posture is consistent
- frozen public surfaces are aligned with actual implementation

## Explicit Non-Goals

Not part of these sprints:

- claims of perfect anonymity
- mixnet or distributed anonymizer routing
- anti-trace networking design
- public reverse-lookup or broad operator console
- full UI/admin product

## Recommended Immediate Next Step

Start Sprint 2 with:

1. alias-scoped identity-link lookup
2. audit event for identity-link creation
3. contract update for the new lookup path
