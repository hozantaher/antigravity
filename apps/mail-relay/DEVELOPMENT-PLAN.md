# Anti-Trace Relay Development Plan

Last updated: 2026-04-07 (validated against RELEASE-TRACK-MEMO.md closure)

## Purpose

This document classifies all remaining `anti-trace-relay` work into
`MVP-track`, `ADR-track`, or `POC-track` items.

Use it to answer:

- what the service should optimize for next
- which work belongs on which track
- what should move before broader expansion

If it conflicts with the canonical service surface, prefer:

- [README.md](README.md)
- [ADR.md](ADR.md)
- [ADR-004-primary-delivery-path.md](ADR-004-primary-delivery-path.md)
- [ADR-005-verification-boundary.md](ADR-005-verification-boundary.md)
- [DEPLOYMENT.md](DEPLOYMENT.md)

## Current Position

The service is in a strong engineering state:

- 30 packages, 116 tests, Go stdlib only, single binary
- local `go test ./...` verification passes in the stabilized default path
- ADR-001 through ADR-005 are all accepted
- primary delivery path is explicit: `bridge -> privacy-gateway intake` (ADR-004)
- verification boundary is explicit (ADR-005)
- release track formally closed with GO for bridge path (RELEASE-TRACK-MEMO.md, 2026-04-04)
- cross-service bridge verification passed (CROSS-SERVICE-VERIFICATION-REPORT.md)

What is weaker than engineering posture is operational maturity for the bridge path
in real production use. The service has never run a sustained production deployment
with real submitters.

## Planning Model

Every meaningful next task is classified before implementation:

- `MVP-track`
  - already inside the intended service scope
  - should move toward usable, testable, and operable delivery
- `ADR-track`
  - blocked mainly by a durable decision that must be recorded
  - should resolve ambiguity before implementation expands
- `POC-track`
  - blocked mainly by uncertainty
  - should reduce risk before any new product truth is added

## Classified Work Items

### MVP-track

#### M1: Bridge Operator Visibility

Goal: improve operator ability to observe and diagnose the bridge delivery pipeline.

Current state:

- `/v1/status` returns queue state
- `/v1/audit-events` returns minimal audit trail
- no structured operator dashboard or alerting surface

Work:

- add bridge delivery outcome to audit events (success, failure, upstream HTTP status)
- add relay queue depth and age metrics to status endpoint
- add bridge target health check (periodic liveness probe against privacy-gateway)

Why MVP: the bridge path is the primary delivery mode and operators need to see
whether it is working without reading logs or guessing.

#### M2: Monitoring and Observability

Goal: give operators enough runtime visibility to detect and respond to problems.

Current state:

- `minlog` provides privacy-safe structured logging
- no metrics export, no alerting hooks, no health history

Work:

- expose Prometheus-compatible metrics endpoint (queue depth, submission rate,
  bridge delivery success/failure rate, relay latency percentiles)
- keep the metrics privacy-safe: no content, no IPs, no real identities, only
  aggregate counters and timing percentiles
- document metric names and operator alerting recommendations

Why MVP: a privacy relay that operators cannot monitor is a privacy relay that
operators cannot trust. This is a core operational requirement for any real deployment.

#### M3: Bridge Error Recovery

Goal: handle bridge delivery failures gracefully.

Current state:

- bridge client does HTTP POST to privacy-gateway
- failure semantics are basic (retry not implemented beyond queue re-scheduling)

Work:

- implement bounded retry with exponential backoff for transient bridge failures
- distinguish permanent failures (4xx) from transient failures (5xx, timeout, connection refused)
- move permanently failed envelopes to a dead-letter state visible in audit
- add operator notification or alerting hook for persistent bridge failure

Why MVP: without error recovery, a brief privacy-gateway restart causes silent
message loss.

#### M4: Graceful Upgrade and Restart

Goal: ensure zero message loss across service restarts.

Current state:

- graceful shutdown with in-flight drain exists
- relay queue persists to encrypted file
- restart recovery path is not explicitly verified end-to-end

Work:

- add explicit restart recovery verification (submit, restart, verify delivery)
- document the operator upgrade procedure
- verify that in-flight drain completes before process exit under realistic load

Why MVP: operators need confidence that routine maintenance does not lose messages.

### ADR-track

#### A1: Production Deployment Strategy

Goal: decide the deployment model for real production use.

Current state:

- Docker and systemd deployment paths exist and are documented
- no decision on the preferred production hosting model
- no decision on whether Railway, dedicated VPS, or self-hosted is primary
- no decision on TLS certificate management strategy for production

Questions to settle:

- is the preferred production deployment a dedicated VPS behind Tor, a Railway
  service, or something else?
- how should TLS certificates be managed in production (Let's Encrypt automation,
  manual, or Tor-only which does not need public TLS)?
- what is the minimum viable production infrastructure (single node is acceptable
  for MVP, but the decision should be explicit)

Why ADR: this is a durable deployment decision that shapes operational procedures,
documentation, and security posture. Implementation should not start until the
deployment model is chosen.

#### A2: Authentication Upgrade Path

Goal: decide when and how to move beyond static bearer tokens.

Current state:

- static bearer token auth works for MVP
- mTLS authenticator exists but is not exercised in any deployment guide
- no decision on when mTLS becomes the recommended production auth

Questions to settle:

- should mTLS be the recommended production auth from day one, or is token auth
  acceptable for initial production?
- if mTLS, what is the CA strategy (self-signed operator CA, or integrated with
  an existing PKI)?
- should there be a per-submitter token model for multi-submitter deployments?

Why ADR: authentication model affects operational procedures, submitter onboarding,
and threat model. Changing it post-deployment is expensive.

### POC-track

#### P1: Full Tor Integration

Goal: validate that the Tor hidden service manager works in a real deployment.

Current state:

- `onion` package implements Tor hidden service lifecycle
- `transport` package implements SOCKS5 and multi-hop chains
- none of this has been verified in a real end-to-end deployment with actual Tor

What is uncertain:

- does the auto-generated torrc work reliably across Tor versions?
- what is the operational cost of running a managed Tor process alongside the relay?
- does the .onion intake path perform acceptably under realistic submission rates?
- how does the operator manage Tor key backup and rotation?

Why POC: the Tor integration is architecturally complete but operationally unproven.
Making production claims about Tor support without real deployment evidence would
violate the honest threat model principle from ADR-001.

Recommended POC scope:

- deploy with Tor enabled on a test VPS
- submit through the .onion address
- measure startup time, submission latency, and resource usage
- document operational friction points

#### P2: Network Isolation Sandbox

Goal: validate whether macOS sandbox-exec or equivalent isolation can restrict
the relay process to only allowed network destinations.

Current state:

- `claude-sandbox/` contains sandbox-exec profiles and POC notes
- no ATR-specific sandbox profile exists
- no verification that sandbox restrictions survive real operation

What is uncertain:

- can sandbox-exec restrict outbound connections to only Tor SOCKS and the bridge
  target without breaking relay operation?
- what is the operator cost of maintaining sandbox profiles across macOS versions?
- is this approach portable to Linux (seccomp-bpf, AppArmor) or only macOS?

Why POC: network isolation is a strong defense-in-depth measure, but the
operational feasibility is unproven. Premature productization would create a
false sense of security.

#### P3: Deaddrop Operational Credibility

Goal: determine whether dead-drop delivery is operationally viable beyond
architecture description.

Current state:

- `constrate`, `pool`, and `deaddrop` packages implement the full constant-rate
  emission and dead-drop slot model
- a live deployment report exists (LIVE-DEPLOYMENT-REPORT.md)
- ADR-004 classifies deaddrop as experimental

What is uncertain:

- what is the real bandwidth and storage cost of constant-rate emission?
- how do operators manage dead-drop slot rotation in practice?
- what usability and abuse tradeoffs emerge when real submitters use dead drops?
- how much cover traffic is materially useful in the intended deployment class?

Why POC: the deaddrop model is the most ambitious anonymity mechanism in the
service. It should prove operational viability before being promoted to a
primary delivery path.

#### P4: Amnesic Client Deployment Practicality

Goal: determine whether the zero-state amnesic submitter is practical for
real submitters in high-risk environments.

Current state:

- `cmd/submit/` implements the amnesic client
- passphrase-derived keys, no persistent state, process exits in seconds
- no real-world user testing

What is uncertain:

- what is the minimum operator and submitter guidance needed?
- where does the current CLI flow become too fragile for real use?
- can a submitter realistically memorize a passphrase and a 64-char hex public key?
- what happens when a submitter makes a typo in the passphrase?

Why POC: the amnesic client is compelling but untested with real users.
Operational friction and user error risk are still unknown.

#### P5: Constant-Rate Emission Economics

Goal: determine the acceptable cost envelope for constant-rate emission.

Current state:

- `constrate` package implements fixed-interval output
- default emission interval is 5 seconds
- no measurement of real bandwidth, storage, or compute cost

What is uncertain:

- what is the monthly bandwidth cost at 5-second emission intervals?
- what is the storage cost of cover traffic?
- is the privacy benefit proportional to the cost?
- what emission interval is acceptable for different threat models?

Why POC: privacy value is plausible, but real cost may change the preferred design.

## What Is Not On Any Track Yet

The following items from ADR-001 Out of Scope remain post-MVP and are not
classified into any active track:

- multi-tenant admin UI
- persistent database backend (PostgreSQL/SQLite)
- HSM/KMS key management
- automated key rotation
- bounce handling and deliverability
- multi-node clustering
- advanced mixnet routing
- client SDK / mobile app

These should only be classified when there is a concrete operational need.

## What Not To Do

Avoid these patterns in the next phase:

- expanding all delivery modes in parallel
- treating every defense layer as equally productized
- adding more threat-model prose without deciding product boundaries
- making stronger anonymity claims than the verified implementation supports
- starting POC work before MVP bridge operations are solid

## Immediate Next Sequence

Use this order:

1. **M1 + M2**: bridge operator visibility and monitoring (these are prerequisites
   for trusting the bridge path in any real deployment)
2. **M3**: bridge error recovery (prevents silent message loss)
3. **A1**: production deployment strategy ADR (must decide before first real deployment)
4. **M4**: graceful upgrade verification (validates restart safety before production)
5. **P1**: Tor integration POC (only after bridge is stable in production)
6. **A2**: authentication upgrade ADR (only when multi-submitter or production hardening is needed)
7. **P3, P4, P5**: deaddrop and amnesic client POCs (only when bridge is stable
   and there is explicit intent to promote deaddrop)
8. **P2**: network isolation sandbox POC (can run in parallel with other POC work)

## Success Condition

This plan is successful when:

- the primary bridge path has real operator visibility and error recovery
- at least one ADR decision is recorded before production deployment
- POC work does not start before MVP bridge operations are solid
- future work no longer mixes productized flow and experimental defense ideas

## Uncertainty Acknowledgment

The following items are honest unknowns at this point:

- whether the bridge path will encounter unexpected operational friction in
  real production (it has only been verified in cross-service testing, not
  sustained production use)
- whether Tor integration will prove operationally practical or will remain
  a theoretical capability
- whether the deaddrop model is economically viable at the scale the service
  is intended for
- what the actual production deployment model will be (VPS, Railway, self-hosted)

These uncertainties are why the POC and ADR tracks exist. They should be resolved
through evidence, not through stronger documentation claims.

## Related Documents

- [README.md](README.md)
- [ADR.md](ADR.md)
- [ADR-004-primary-delivery-path.md](ADR-004-primary-delivery-path.md)
- [ADR-005-verification-boundary.md](ADR-005-verification-boundary.md)
- [DEPLOYMENT.md](DEPLOYMENT.md)
- [CROSS-SERVICE-VERIFICATION-REPORT.md](CROSS-SERVICE-VERIFICATION-REPORT.md)
- [RELEASE-TRACK-MEMO.md](RELEASE-TRACK-MEMO.md)
- [CURRENT-STATUS.md](CURRENT-STATUS.md)
