# Privacy Gateway RC Checklist Snapshot

## Current Status

- decision: `NO-GO`
- local core: `PASS`
- API contract: `FROZEN`
- remaining release blockers: `native submission relay verification is not PASS in provider-backed run; inbound IMAP verification is not PASS in provider-backed run; restart persistence verification is not PASS; incremental sync verification is not PASS; privacy-first read-model verification is not PASS; overall live verification is not PASS`

## Done

- MVP scope defined
- MVP backlog cut
- HTTP API contract frozen
- local `record-only` rehearsal passed
- alias flow verified locally
- outbound flow verified locally
- persistence and restart verified locally
- encrypted local storage observed
- operator guide exists
- smoke test exists
- live verification plan exists
- provider playbook exists

## Remaining

- native submission relay verification is not PASS in provider-backed run
- inbound IMAP verification is not PASS in provider-backed run
- restart persistence verification is not PASS
- incremental sync verification is not PASS
- privacy-first read-model verification is not PASS
- overall live verification is not PASS

## Go Condition

Release candidate becomes `GO` when all of the following are true:

1. real SMTP verification passes
2. real IMAP verification passes
3. privacy-first read-model checks pass during the live run
4. live verification result is recorded
5. no critical security issue is discovered
6. no API contract break is introduced

## No-Go Condition

Remain `NO-GO` if any of the following are true:

- SMTP fails in the real provider environment
- IMAP fails in the real provider environment
- timeline or channel read models break under live provider conditions
- verification exposes open-relay or comparable critical security behavior
- release work changes the frozen MVP contract

## Release Posture

This project is not blocked by product definition anymore.
It is blocked only by provider-backed release verification.

## Recommended Next Move

Resolve listed blockers, rerun provider-backed verification, and regenerate RC summary.
