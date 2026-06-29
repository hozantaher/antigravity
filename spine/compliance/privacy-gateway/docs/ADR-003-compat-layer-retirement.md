# ADR-003: Compatibility Layer Retirement Path

- **Status:** Accepted
- **Date:** 2026-04-04

## Context

`privacy-gateway` currently exposes two outbound-facing shapes:

- the newer privacy-first path built around:
  - `submissions`
  - `relay_attempts`
  - `audit_events`
  - intake and queue/release controls
- the legacy compatibility path:
  - `POST /v1/messages`
  - `GET /v1/messages/outbox`
  - `GET /v1/messages/inbox`
  - `POST /v1/messages/inbox/sync`

Internally, the legacy path already runs through the new bounded contexts via `internal/compat/messages_gateway.go`.

This means the compatibility layer is no longer the system of record.
It is already an adapter.

The open question was not whether the compatibility layer exists.
The open question was how long it should stay first-class and how to retire it without breaking the current MVP and verification posture.

## Decision

We keep the compatibility layer as a **supported legacy bridge**, but not as the preferred product path.

### Preferred product path

The preferred privacy-first surface is now:

- `POST /v1/submissions`
- `GET /v1/submissions`
- `GET /v1/submissions/{id}`
- `GET /v1/submissions/{id}/timeline`
- intake-owned submission, queue, release, timeline, and dashboard flows

### Legacy compatibility path

The `/v1/messages` path remains supported for now because it still provides:

- backward-compatible outbound send behavior
- current release-verification flow used in local and provider-backed runbooks
- continuity for existing alias-centric clients

But it is explicitly classified as:

- legacy
- compatibility-oriented
- not the long-term primary interface

## Retirement Phases

### Phase 1: Current State

Current state is:

- `/v1/messages` remains available
- `compat.MessagesGateway` translates legacy sends into:
  - `Submission`
  - `RelayAttempt`
  - `AuditEvent`
- the legacy response shape remains available
- product growth should prefer the submission/intake surfaces first

### Phase 2: Preference Shift

During this phase:

- new privacy-first features should land in:
  - `submissions`
  - intake surfaces
  - timelines
  - queue/release flows
- no major new product capability should be designed primarily around `/v1/messages`
- docs should continue to describe `/v1/messages` as compatibility or legacy API

This phase is already in progress.

### Phase 3: Explicit Deprecation

This phase may begin only after:

- at least one real provider-backed verification run succeeds
- the newer product surfaces are sufficient for normal operator and integration use
- release guidance no longer depends on `/v1/messages` as the main demonstration path

At that point:

- `/v1/messages` should be explicitly marked deprecated in canonical docs
- operator and verification guides should use submission/intake flows as the default examples
- legacy examples may remain as compatibility references

### Phase 4: Removal Candidate

Actual removal should happen only when all of these are true:

- there is no release-critical path that depends on `/v1/messages`
- provider-backed verification can be completed without it
- existing local/operator workflows have a clear submission/intake replacement
- contract and changelog updates are made together

Until then, `compat` stays as an adapter, not as accidental core logic.

## Consequences

### Positive

- the repo now has a stable answer about the role of `/v1/messages`
- new work has a cleaner routing rule:
  - privacy-first feature -> submissions/intake
  - compatibility need -> messages/compat
- the compat layer can remain useful without pretending to be the target architecture

### Tradeoffs

- the service will carry two outward-facing modes for a while
- release documentation must remain clear about which surface is preferred and which is legacy
- some provider-run artifacts will still mention `/v1/messages` until Phase 3 is complete

## Rejected Alternatives

### 1. Remove `/v1/messages` immediately

Rejected because:

- current verification material still depends on it
- compatibility flow still provides a stable bridge for existing behavior
- removal now would create churn without increasing release confidence

### 2. Keep `/v1/messages` indefinitely as co-equal primary API

Rejected because:

- it would blur the privacy-first product direction
- it would reward new development against the legacy surface
- it would keep `compat` alive as an accidental core domain

### 3. Redirect `/v1/messages` automatically right now

Rejected because:

- current clients and runbooks still expect the legacy behavior directly
- redirect semantics do not map cleanly to the current API shape

## Operational Rule

From this point on:

- new product capabilities should not start in `compat`
- new operator and intake workflows should target submission-centric surfaces
- any broadening of `/v1/messages` must be treated as an exception and justified explicitly

## Current Implementation References

- [messages_gateway.go](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/internal/compat/messages_gateway.go)
- [ARCHITECTURE-BOUNDED-CONTEXTS.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/ARCHITECTURE-BOUNDED-CONTEXTS.md)
- [API-CONTRACT-FREEZE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/API-CONTRACT-FREEZE.md)
- [VERIFICATION-GUIDE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/VERIFICATION-GUIDE.md)
