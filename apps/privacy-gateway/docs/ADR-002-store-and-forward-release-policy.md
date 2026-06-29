# ADR-002: Store-And-Forward Release Policy

- **Status:** Accepted
- **Date:** 2026-04-04

## Context

`privacy-gateway` now exposes explicit queue and release actions for submissions:

- operator flow:
  - `POST /v1/submissions/{id}/queue`
  - `POST /v1/submissions/{id}/release`
- intake-owned flow:
  - `POST /v1/intake/submissions/{id}/queue`
  - `POST /v1/intake/submissions/{id}/release`

The implementation already enforces a real lifecycle:

- queueing moves a submission into `queued`
- releasing moves a queued submission back into `sanitized`
- actual successful delivery is represented separately by `relayed`
- retryable relay failures can re-enter the queue

Until now, this behavior existed mostly in code and contract notes, but not as an explicit architectural decision.

That left three risks:

1. `release` could be misread as “deliver now”
2. future work could accidentally collapse `queued`, `sanitized`, and `relayed`
3. queue semantics could drift between operator and intake surfaces

## Decision

We treat queue and release as **internal store-and-forward control actions**, not as delivery claims.

### Queue semantics

Queueing means:

- the submission is intentionally held in the internal store-and-forward boundary
- the system records the state as `queued`
- `delivery_boundary` stays `internal_store_and_forward`
- an audit event is recorded

Queueing is allowed for:

- `accepted`
- `sanitized`
- `queued`
- `failed` only when the failure disposition is `retryable`

Queueing is not allowed for:

- `relayed`
- `blocked`
- terminal `failed`

### Release semantics

Release means:

- the submission is released from manual hold back into relay-ready flow
- the system records the state as `sanitized`
- `delivery_boundary` remains `internal_store_and_forward`
- no claim of external delivery is made
- an audit event is recorded

Release is allowed only for:

- `queued`

Release does **not** mean:

- immediate SMTP handoff
- final delivery
- transition to `relayed`
- transition to `trusted_delivery_boundary`

### Delivery boundary semantics

The boundary model is now:

- `internal_store_and_forward`
  - submission is still inside the controlled gateway boundary
  - includes accepted, sanitized, queued, and retryable failed items still under internal control
- `trusted_delivery_boundary`
  - submission has crossed into actual relay delivery flow and was marked `relayed`

This means queue and release actions stay entirely inside the internal boundary.

Only real relay success may move a submission to `trusted_delivery_boundary`.

### Source-path semantics

Manual control paths must remain explicit.

Current allowed examples:

- `manual_queue`
- `manual_release`
- `intake_manual_queue`
- `intake_manual_release`

These values exist to preserve auditability across operator and intake surfaces.

## Consequences

### Positive

- queue and release now have a stable meaning
- operator and intake flows share one lifecycle model
- `relayed` remains reserved for actual delivery outcome
- future retry logic can build on the same state model

### Tradeoffs

- `sanitized` now carries two meanings:
  - sanitized after intake/policy processing
  - released back into relay-ready flow after manual hold
- clients must not interpret `release` as delivery
- richer queue states such as `on_hold` or `awaiting_review` remain out of scope for now

## Rejected Alternatives

### 1. Make `release` transition directly to `relayed`

Rejected because:

- it would falsely claim delivery before relay success exists
- it would collapse manual workflow with transport outcome

### 2. Make `release` transition back to `accepted`

Rejected because:

- it would lose the meaning that the submission already passed sanitizer/policy handling
- it would blur the line between fresh intake and relay-ready resumption

### 3. Introduce a new dedicated status immediately

Examples:

- `ready_for_relay`
- `on_hold`
- `released`

Rejected for now because:

- the current lifecycle is already workable
- the service does not yet need a larger workflow taxonomy
- this would widen contracts before provider-backed verification is complete

## Operational Rule

If future work needs more queue nuance, it should not silently overload current states.

It must do one of:

1. extend this ADR
2. add a follow-up ADR for richer queue lifecycle states
3. update contracts and operator docs together

## Current Implementation References

- [service.go](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/internal/submission/service.go)
- [server.go](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/internal/httpapi/server.go)
- [API-CONTRACT-FREEZE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/API-CONTRACT-FREEZE.md)
