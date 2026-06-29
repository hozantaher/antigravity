# POC: Dead Drop Operational Credibility

## Status: Deferred (pending bridge MVP completion)

## Hypothesis

The dead drop flow (constant-rate emission + pool mixing + HMAC-derived slots) is operationally reliable enough for a real deployment.

## Scope

- In scope: operator workflow test (setup, monitoring, troubleshooting)
- In scope: abuse resistance analysis (slot exhaustion, replay, timing correlation)
- In scope: operational failure modes (slot TTL, pool drain, emission stall)
- Out of scope: formal anonymity proofs (academic scope, not MVP)

## Success Signal

An operator can:
1. Configure deaddrop mode with reasonable defaults
2. Submit a message that arrives at the correct slot within one emission interval
3. Poll the slot and retrieve the message
4. Observe cover traffic statistics via `/v1/status`
5. Recover from a restart without losing pooled messages (persistent pool)

## Failure Signal

- Messages are lost silently (pool drain without delivery)
- Slot collisions cause message corruption
- Emission stalls under normal load
- Operator cannot distinguish real delivery from cover traffic (monitoring blind spot)

## Current Evidence

The live deployment report (`LIVE-DEPLOYMENT-REPORT.md`) demonstrates:
- Successful post and poll flow
- Slot derivation determinism
- Cover traffic emission at constant rate

This is architectural plausibility, not operational credibility. Missing:
- Multi-hour run stability test
- Failure injection (network partition, disk full, memory pressure)
- Abuse scenario walkthrough (malicious poster, slot flooding)

## Prerequisites

1. Phase A (privacy-gateway RC) complete
2. Bridge MVP path stable (ADR-004 primary path proven)
3. Sandboxed test environment available (Phase F)

## Decision

**Deferred** until bridge MVP is proven and a sandboxed test environment is available. The existing implementation is architecturally sound but operationally unproven at sustained runtime.

## Review Date: After Phase A RC decision and Phase F sandbox stabilization.
