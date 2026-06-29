# ADR-007: Authentication Upgrade Path

**Status:** Accepted
**Date:** 2026-04-05
**Authors:** Spec Kit Codex Stack core council
**Scope:** `services/anti-trace-relay/` authentication model for initial production deployment and multi-submitter upgrade path

---

## 1. Context

`anti-trace-relay` ships with two authentication implementations in `internal/auth/`:

- `StaticTokenAuthenticator` — constant-time bearer token comparison against a registered token map
- `MTLSAuthenticator` — client certificate identity extracted from TLS `PeerCertificates` by Subject CN
- `CompositeAuthenticator` — tries a list of authenticators in order; first success wins

Both implementations exist and are tested. The question is which to activate by default for initial production, what CA strategy to apply if mTLS is adopted, and how the token model should evolve when multi-submitter deployments arise.

Without a durable decision, operators are left to guess the intended authentication posture, and the upgrade path from single-submitter MVP to multi-submitter production is unclear.

---

## 2. Decision Drivers

| Driver | Weight | Rationale |
|--------|--------|-----------|
| Operational simplicity for single-operator MVP | Critical | First deployments are single-operator; complexity must be justified by need |
| Security adequacy | Critical | Even Tor-only deployments must authenticate; no-auth is not acceptable |
| Honest threat model | High | Auth model must match actual submitter trust topology |
| Upgrade path clarity | High | Multi-submitter deployments need a clear, documented migration path |
| CA operational overhead | High | Self-signed CA setup and cert rotation is non-trivial; must be justified |
| Constant-time correctness | High | Token comparison must be timing-safe regardless of token count |
| Existing implementation reuse | Medium | Both authenticators already exist; choice is configuration, not new code |

---

## 3. Decision

### 3.1 Initial Production Auth: Static Bearer Token

Static bearer token authentication (`StaticTokenAuthenticator`) is the recommended authentication model for initial production deployment.

This means:

- the `DEV_API_TOKEN` environment variable (already required at startup) provides the single shared token for single-submitter MVP
- the token is compared constant-time against all registered tokens to prevent timing oracle; this property holds regardless of how many tokens are registered
- no CA setup, no certificate provisioning, and no cert rotation burden is imposed on the first operator

Bearer tokens are sufficient for single-operator deployments because:

- there is one submitter with one shared secret
- the risk from token theft is manageable when the channel is Tor-only or TLS 1.3 with strict cert requirements
- token rotation is operationally simple (restart with new env var value)

### 3.2 Token Model for Single-Submitter MVP

For the single-submitter MVP:

- a single shared token is the correct model
- the token maps to a single `Actor` in the `StaticTokenAuthenticator` token map
- no per-submitter token differentiation is required until multiple submitters with different trust levels exist

### 3.3 Token Model for Multi-Submitter Deployments

When multi-submitter need arises:

- introduce per-submitter tokens: each submitter receives a distinct token mapped to a distinct `Actor` with its own `ID` and `TenantID`
- the `StaticTokenAuthenticator` already supports this natively via its token map; no code changes are required
- per-submitter tokens enable actor-scoped rate limiting, audit trail attribution, and selective revocation without mTLS complexity

Per-submitter token management (provisioning, rotation, revocation) should be handled by the operator at the config layer; automated token lifecycle management is out of scope for MVP.

### 3.4 mTLS: Deferred Until Multi-Submitter Trust Separation Requires It

mTLS via `MTLSAuthenticator` is available but deferred.

mTLS should not be activated until both of these are true:

1. multiple submitters exist with genuinely different trust levels (not just different identities)
2. the operator can justify the CA operational burden: CA setup, certificate issuance, cert rotation, and revocation infrastructure

The added security property of mTLS over bearer tokens — eliminating token theft as an attack vector — is not worth the operational cost for a single-operator deployment.

### 3.5 CA Strategy When mTLS Is Adopted

When mTLS is eventually adopted:

- a self-signed operator CA is the recommended approach
- the operator generates a CA keypair, issues client certificates for each submitter signed by that CA, and configures the relay with the CA cert via `LoadClientCACert`
- the `MTLSAuthenticator` maps certificate Subject CN to `Actor`; CNs should be stable, meaningful identifiers (e.g. `submitter-org-name`)
- external public CAs are not recommended; they introduce third-party visibility into submitter enrollment

Migration can use `CompositeAuthenticator` to run mTLS first and fall back to bearer token during a transition window, then drop the bearer token leg once all submitters have certificates.

### 3.6 No-Auth Is Not Acceptable

Unauthenticated access is not acceptable even for Tor-only (.onion) deployments.

Rationale: a hidden service address is not a secret credential. Knowledge of the .onion address is not equivalent to authorization. Without authentication, any party that discovers the address can submit messages, exhaust the relay queue, generate audit noise, or probe the pipeline.

---

## 4. Consequences

### Positive

- initial deployment is simple: one env var, no CA, no cert tooling
- token model scales to multi-submitter without code changes
- mTLS upgrade path is clear and already implemented; switching is a config decision
- `CompositeAuthenticator` enables a clean migration window when mTLS is eventually adopted
- per-submitter token model preserves actor-scoped audit trail and rate limiting

### Negative

- bearer tokens can be stolen from env vars or secrets files if the host is compromised; mTLS would eliminate this vector
- single shared token for MVP means all API access is indistinguishable in the audit trail until per-submitter tokens are introduced
- operator must manage cert rotation manually if mTLS is adopted; no automated lifecycle tooling exists in MVP

---

## 5. Operational Rule

Going forward:

- activate `StaticTokenAuthenticator` with a single token for single-submitter production deployments
- treat `DEV_API_TOKEN` as the production token name; the "DEV" prefix reflects its origin but the implementation is production-grade
- when adding a second submitter, introduce per-submitter tokens before or instead of adopting mTLS
- adopt mTLS only when multiple submitters with different trust levels require cryptographic identity binding
- when adopting mTLS, use a self-signed operator CA and migrate via `CompositeAuthenticator`

---

## 6. Alternatives Considered

### Alternative 1: mTLS from Day One

Rejected.

mTLS eliminates token theft as an attack vector and provides stronger cryptographic identity binding. However, for a single-operator MVP the additional security is not justified against the cost:

- the operator must provision a CA, generate and distribute client certificates, and manage cert rotation
- there is no existing tooling in the service for automated cert lifecycle management
- a single operator with a single submitter has no multi-party trust problem to solve
- the bearer token threat model is acceptable when the channel is Tor or TLS 1.3 with a controlled server cert

### Alternative 2: No Authentication for Tor-Only Deployments

Rejected.

A .onion address is not a credential. Unauthenticated intake creates unbounded abuse surface even on a hidden service. The existing `StaticTokenAuthenticator` is constant-time, requires no infrastructure overhead, and is already required at startup; there is no justification for removing it.

---

## 7. Follow-On Work

This ADR implies the following future decisions when multi-submitter need arises:

1. define per-submitter token provisioning and revocation policy
2. decide whether to promote mTLS when multi-submitter trust separation requires it
3. if mTLS is adopted, document the self-signed CA setup and `CompositeAuthenticator` migration procedure
4. evaluate automated cert rotation tooling at that time
