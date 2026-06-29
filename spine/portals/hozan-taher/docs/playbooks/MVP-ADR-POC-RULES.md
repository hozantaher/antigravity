# MVP / ADR / POC Rules

## Purpose

This document defines how new work should be classified before it turns into code, contracts, or roadmap noise.

Use it to decide whether a change belongs in:

- `MVP`
- `ADR`
- `POC`

This is a governance rule for the whole monorepo.

## Short Definitions

### MVP

`MVP` defines the smallest honest product boundary.

It answers:

- what must exist for this service or product slice to count as real
- what is intentionally in scope
- what is intentionally out of scope
- what user-facing or operator-facing outcomes must work

`MVP` is about scope, not implementation detail.

### ADR

`ADR` records a durable architectural or operational decision.

It answers:

- what decision was made
- why it was made
- what alternatives were rejected
- what consequences now follow

`ADR` is about decisions, not execution status.

### POC

`POC` is a proof-of-concept or proof-of-feasibility artifact.

It answers:

- what uncertainty exists
- what is being tested
- what evidence would count as success or failure
- what decision should follow from the result

`POC` is about reducing uncertainty, not declaring product truth.

## Decision Rule

Before starting meaningful new work, ask these in order:

1. Is this already known to belong inside the service's intended product boundary?
   - If yes, it is `MVP-track`.
2. Is the main blocker an unresolved durable decision?
   - If yes, it is `ADR-track`.
3. Is the main blocker uncertainty about feasibility, risk, or value?
   - If yes, it is `POC-track`.

If the answer is still unclear, default to `POC-track`, not direct feature work.

## Allowed Outputs

### MVP-track output

Should update one or more of:

- service `README.md`
- service `MVP.md` or equivalent product-boundary doc
- canonical contract doc
- implementation and tests
- current status or roadmap reference only if needed

### ADR-track output

Should update one or more of:

- existing ADR
- new ADR
- canonical architecture/operations document

It may also trigger implementation, but only after the decision is explicit.

### POC-track output

Should create or update:

- `POC-*.md`
- or service-local `pocs/`
- or clearly named experimental notes

Every POC should include:

- hypothesis
- scope of experiment
- success signal
- failure signal
- next decision

## Mandatory End State For Every POC

Every `POC` must end in one of these states:

1. `accepted`
   - promote the result into an `ADR` or canonical service document
2. `rejected`
   - keep as reference or archive
3. `deferred`
   - keep as unresolved experiment, but do not silently treat it as product truth

Do not leave POCs half-alive as informal roadmap assumptions.

## What Not To Do

Do not:

- treat a roadmap idea as an ADR
- treat a prototype as an MVP commitment
- treat sprint progress as proof of a stable decision
- merge unresolved experiments directly into canonical product language
- create a new status document when the real missing piece is an ADR or POC

## Service-Level Pattern

Each active service should converge toward this pattern:

1. one `MVP` or equivalent product-boundary surface
2. one ADR set for durable decisions
3. one explicit place for `POC` work
4. implementation and verification beneath that chain

Not every service needs a large POC library.

But every service should have a clear answer to:

- where product scope lives
- where decisions live
- where experiments live

## Privacy-Gateway As Reference Example

For [features/compliance/privacy-gateway](/Users/messingtomas/Taher/hozan-taher/features/compliance/privacy-gateway):

- `MVP` lives in [MVP.md](/Users/messingtomas/Taher/hozan-taher/features/compliance/privacy-gateway/MVP.md)
- current public contract lives in [API-CONTRACT-FREEZE.md](/Users/messingtomas/Taher/hozan-taher/features/compliance/privacy-gateway/API-CONTRACT-FREEZE.md)
- current execution posture lives in [CURRENT-STATUS.md](/Users/messingtomas/Taher/hozan-taher/features/compliance/privacy-gateway/CURRENT-STATUS.md)
- future uncertainty should move into explicit POC or ADR artifacts instead of expanding roadmap prose alone

## Rule Going Forward

For new work in this repository:

1. classify it as `MVP`, `ADR`, or `POC`
2. update the nearest canonical service-local artifact first
3. only then implement or extend reference docs

This rule exists to reduce scope drift and to stop the pattern:

- idea
- immediate feature work
- post-hoc explanation

The preferred pattern is:

- uncertainty
- experiment if needed
- decision
- scoped implementation
