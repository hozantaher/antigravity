# Privacy Gateway MVP Backlog Cut

## Purpose

This document defines the final backlog boundary for the MVP release.

Its job is simple:

- protect the current MVP from scope creep
- show what is still worth doing before release
- show what must wait until after release

This cut is based on the current MVP definition, release checklist, frozen API contract, and completed local verification run.

## Current Position

Current status:

- local MVP core: `PASS`
- API contract: `FROZEN`
- release blockers: only real provider verification remains

The project is no longer in a feature-discovery phase.
It is in a release-hardening phase.

## Must-Have Before MVP Release

These items are still valid before calling the service MVP-ready:

- run one real native submission create + relay verification against a provider-backed environment
- run one real inbound IMAP verification against a provider-backed environment
- record the provider-backed verification result in the existing run/report docs
- keep the current API contract stable unless a clear release blocker forces a documented change

## Nice-To-Have Before Release

These items are acceptable only if they are low-risk and do not expand scope:

- small README or operator-guide clarifications
- small error-message wording improvements that do not change response shape
- small implementation cleanup that does not change behavior
- additional tests that increase confidence without changing the contract

If an item risks changing payload shape, endpoint semantics, or delivery/inbox behavior, it should not be treated as a release-polish task.

## Explicitly Out Of Scope For MVP

The following work is cut from the MVP release:

- POP3 support
- admin UI
- multi-user operator console
- attachment download pipeline
- attachment rendering
- quarantine workflow
- bounce handling and deliverability lifecycle
- provider webhooks
- database migration from file-backed persistence
- KMS/HSM-backed secret management
- advanced MIME reconstruction
- richer nested media handling
- configurable attachment-policy UI or rule engine
- distributed anonymizer or mixnet-style routing
- any product claim of perfect, maximal, or untraceable anonymity

## Freeze Rules

Before MVP release, do not add new product surface unless it directly removes a release blocker.

That means:

- no new endpoints
- no new top-level response shapes
- no new user flows
- no new provider matrix expansion unless needed for the first successful live verification

Allowed changes:

- additive documentation
- test additions
- bug fixes
- verification artifacts
- narrowly scoped hardening that preserves the frozen contract

## Decision Rule

Use this rule for any proposed next task:

1. Does it directly support one of the 3 MVP flows?
2. Does it directly help release verification or operational readiness?
3. Does it preserve the frozen API contract?

If the answer is not clearly yes, the task belongs after MVP.

## Recommended Next Actions

In order:

1. perform one real provider-backed native submission relay run
2. perform one real provider-backed IMAP run
3. write the live verification result
4. call the first MVP release candidate

## Post-Release Queue

After MVP release, the most sensible next themes are:

- inbound quarantine flow
- richer MIME handling
- stronger production secret and persistence posture
- attachment policy configuration
- operator/admin capabilities
- provider lifecycle handling such as bounce states and delivery diagnostics
