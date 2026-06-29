# Privacy Gateway RC Decision Memo

## Purpose

This memo defines the `go / no-go` rule for the first MVP release candidate.

It is intentionally short.
The point is to avoid re-arguing release readiness once the remaining verification work is complete.

## Current Decision

Current decision: `NO-GO`

Reason:

- the local MVP core has passed
- the API contract is frozen
- native submission relay verification is not PASS in provider-backed run
- inbound IMAP verification is not PASS in provider-backed run
- restart persistence verification is not PASS
- incremental sync verification is not PASS
- privacy-first read-model verification is not PASS
- overall live verification is not PASS

This is not a product-scope problem.
It is a release-verification problem.

## What Is Already True

The following conditions are already satisfied:

- MVP scope is defined
- MVP backlog is cut
- local `record-only` verification passed
- persistence and restart behavior were verified locally
- encrypted local state was observed
- the HTTP contract is frozen for MVP
- operator and verification docs exist
- test and coverage expectations are already represented in the current build posture

## Release Gates

The first release candidate is `GO` only if all of the following are true:

1. one real SMTP provider-backed verification run passes
2. one real IMAP provider-backed verification run passes
3. privacy-first read-model checks pass during the live verification run
4. the live verification result is written down in the existing verification artifacts
5. no API contract change is introduced during the release-hardening phase
6. no new critical security issue is discovered during live verification

If any of those conditions fail, the decision remains `NO-GO`.

## Acceptable MVP Limitations

The following limitations do not block MVP release:

- file-backed persistence instead of a database
- metadata-only attachment handling
- no quarantine workflow
- no admin UI
- no POP3 support
- no advanced MIME reconstruction
- no claim of perfect or untraceable anonymity

These are accepted MVP constraints, not release blockers.

## Non-Acceptable Release Risks

The following are release blockers:

- native submission create + relay cannot complete in a real provider-backed environment
- inbound IMAP sync cannot complete in a real provider-backed environment
- channel or inbox timelines collapse under the provider-backed run in a way that breaks the privacy-first operator model
- live verification exposes a contract-breaking behavior
- live verification exposes open-relay behavior or a comparable critical security flaw
- release work expands scope beyond the frozen MVP contract

## Decision Rule

Use this simple rule:

- local pass + no live verification = `NO-GO`
- local pass + live provider pass = `GO`

## Recommended Next Step

Proceed directly to the next provider-backed verification pass and refresh the existing live verification report artifacts from that run.
