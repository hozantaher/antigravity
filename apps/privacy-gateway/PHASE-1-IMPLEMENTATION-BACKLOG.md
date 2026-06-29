# Phase 1 Implementation Backlog

## Purpose

This backlog turns the privacy-first pivot plan into the first concrete implementation iteration.

Phase 1 is intentionally narrow.
It does not introduce the full new product yet.
Its job is to create the internal skeleton for the pivot without breaking the current gateway.

## Phase 1 Goal

Create the new bounded-context skeleton for:

- `submission`
- `identityvault`
- `sanitizer`
- `relay`
- `audit`

while keeping the current API and current mail flows working.

## Phase 1 Non-Goals

Do not do these in Phase 1:

- new public endpoints
- full identity-vault behavior
- new auth model
- retention jobs
- submission UI
- provider-behavior changes

Phase 1 is an architecture-and-contract iteration, not a feature-release iteration.

## Expected Output

At the end of Phase 1, the codebase should have:

- new internal package boundaries
- explicit interfaces between bounded contexts
- compatibility wiring from current handlers into the new internal services
- tests proving the old flows still work
- no API contract break

## Backlog

## Track A: Package Skeleton

### A1. Add `internal/submission`

Create:

- `internal/submission/service.go`
- `internal/submission/repository.go`
- `internal/submission/memory_repository.go`
- `internal/submission/service_test.go`

Responsibilities:

- define the `Submission` lifecycle abstraction
- define repository interface
- provide in-memory implementation for first integration

Definition of done:

- package compiles
- memory repository works
- unit tests cover create/list/get basics

### A2. Add `internal/identityvault`

Create:

- `internal/identityvault/service.go`
- `internal/identityvault/repository.go`
- `internal/identityvault/memory_repository.go`
- `internal/identityvault/service_test.go`

Responsibilities:

- define `IdentityLink`
- define restricted lookup interface
- keep reverse-lookup semantics explicit

Definition of done:

- package compiles
- lookup interface is narrow
- tests cover create/list/get semantics

### A3. Add `internal/sanitizer`

Create:

- `internal/sanitizer/service.go`
- `internal/sanitizer/service_test.go`

Responsibilities:

- centralize outbound and inbound sanitization contracts
- start with wrapper behavior around existing normalization rules

Definition of done:

- package compiles
- service exposes explicit methods such as:
  - `SanitizeOutbound`
  - `SanitizeInbound`
- tests cover current baseline rules

### A4. Add `internal/relay`

Create:

- `internal/relay/service.go`
- `internal/relay/service_test.go`

Responsibilities:

- wrap current mail gateway behavior behind a relay-facing service
- define future split between submission and relay attempt

Definition of done:

- service delegates to current gateway cleanly
- tests cover compatibility behavior

### A5. Add `internal/audit`

Create:

- `internal/audit/service.go`
- `internal/audit/memory_store.go`
- `internal/audit/service_test.go`

Responsibilities:

- define `AuditEvent`
- allow recording non-sensitive operator/system events

Definition of done:

- package compiles
- in-memory event recording works
- tests cover append/list behavior

## Track B: Shared Model Refactor

### B1. Extend `internal/model/model.go`

Add initial models:

- `Submission`
- `SubmissionStatus`
- `IdentityLink`
- `RelayAttempt`
- `AuditEvent`
- `SanitizationResult`

Definition of done:

- new models exist
- existing models remain backward-compatible
- no current handler contract breaks

### B2. Keep Legacy Model Compatibility

Rules:

- do not rename existing `Alias`, `MessageRecord`, or `InboxMessage` fields
- add only new models or additive fields where needed

Definition of done:

- API freeze document remains valid for current endpoints

## Track C: Wiring Refactor

### C1. Introduce New Internal Wiring In `main.go`

Update:

- [main.go](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/cmd/privacy-gateway/main.go)

Tasks:

- instantiate new services
- keep current `httpapi.Server` behavior unchanged
- wire current outbound flow through new internal relay/sanitizer abstractions where possible

Definition of done:

- service starts successfully
- no current route behavior changes

### C2. Keep `httpapi.Server` Stable

Rules:

- no new public endpoints in Phase 1
- no response-shape changes for current routes

Definition of done:

- current `server_test.go` remains green

## Track D: Compatibility Adapters

### D1. Add `messages -> submission` internal adapter

Purpose:

- allow the current `/v1/messages` flow to begin using a `submission` abstraction internally without changing the public API yet

Definition of done:

- current send flow still returns the same response shape
- internally the service can create a submission-shaped record or equivalent compatibility object

### D2. Add alias-to-vault compatibility hook

Purpose:

- allow alias creation to optionally write an identity-link record in the new vault layer

Definition of done:

- no current alias API change
- compatibility path tested

## Track E: Tests

### E1. Add unit tests for all new bounded contexts

Required:

- submission tests
- identityvault tests
- sanitizer tests
- relay tests
- audit tests

### E2. Add integration tests proving no regression

Required:

- current alias flow still works
- current `/v1/messages` flow still works
- current inbox flow still works

### E3. Keep current project bar

Required:

- green `go test ./...`
- no regression below current engineering expectations

## Track F: Documentation

### F1. Add bounded-context overview

Create:

- `ARCHITECTURE-BOUNDED-CONTEXTS.md`

Content:

- role of each new package
- allowed dependencies between packages
- current legacy compatibility notes

Status:

- `DONE`

### F2. Update pivot plan references

Update:

- [PRIVACY-FIRST-PIVOT-PLAN.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/PRIVACY-FIRST-PIVOT-PLAN.md)
- [README.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/README.md)

Definition of done:

- Phase 1 backlog and context overview are discoverable from README

Status:

- `DONE`

## Recommended Commit Order

Use this order:

1. add new model types
2. add package skeletons with tests
3. add relay and sanitizer wrappers
4. wire new services in `main.go`
5. add compatibility adapters
6. update docs
7. run full test pass

## Suggested File Additions

Phase 1 is likely to add these files:

- `internal/submission/service.go`
- `internal/submission/repository.go`
- `internal/submission/memory_repository.go`
- `internal/submission/service_test.go`
- `internal/identityvault/service.go`
- `internal/identityvault/repository.go`
- `internal/identityvault/memory_repository.go`
- `internal/identityvault/service_test.go`
- `internal/sanitizer/service.go`
- `internal/sanitizer/service_test.go`
- `internal/relay/service.go`
- `internal/relay/service_test.go`
- `internal/audit/service.go`
- `internal/audit/memory_store.go`
- `internal/audit/service_test.go`
- `ARCHITECTURE-BOUNDED-CONTEXTS.md`

## Phase 1 Exit Criteria

Phase 1 is complete when:

- new bounded-context packages exist
- current endpoints still behave the same
- the codebase has an explicit place for submission, vault, sanitizer, relay, and audit responsibilities
- the next iteration can add `POST /v1/submissions` without another structural refactor

Current status:

- Track A: `DONE`
- Track B: `DONE`
- Track C: `DONE`
- Track D: `DONE`
- Track E: `DONE`
- Track F: `DONE`

## Recommended Next Step After Phase 1

Phase 2 should be:

- implement `POST /v1/submissions`
- persist `Submission`
- keep `/v1/messages` as compatibility path
