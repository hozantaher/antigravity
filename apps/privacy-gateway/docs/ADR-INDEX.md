# ADR Index

## Role

This document is the shortest navigation map for accepted architectural decisions in `privacy-gateway`.

It is not the primary source of product truth.

Prefer these first when they answer the question directly:

- [README.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/README.md)
- [MVP.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/MVP.md)
- [API-CONTRACT-FREEZE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/API-CONTRACT-FREEZE.md)
- [OPERATOR-GUIDE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/OPERATOR-GUIDE.md)

Use this index when you need to answer:

- which architecture decisions are already accepted
- where queue/release semantics are defined
- where legacy compatibility retirement is defined
- where the RC decision boundary is defined

## Accepted ADRs

### [ADR-001-quality-standards.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/docs/ADR-001-quality-standards.md)

Purpose:

- cross-project quality and verification standards

Current role:

- quality baseline and engineering discipline reference

### [ADR-002-store-and-forward-release-policy.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/docs/ADR-002-store-and-forward-release-policy.md)

Purpose:

- define queue and release semantics for internal store-and-forward flow

Current role:

- lifecycle decision for `queued`, `sanitized`, and `trusted_delivery_boundary`

### [ADR-003-compat-layer-retirement.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/docs/ADR-003-compat-layer-retirement.md)

Purpose:

- define the retirement path for legacy `/v1/messages`

Current role:

- decision that `compat` remains a supported bridge, not the preferred product path

### [ADR-004-release-candidate-decision-boundary.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/docs/ADR-004-release-candidate-decision-boundary.md)

Purpose:

- define the first RC `GO / NO-GO` boundary

Current role:

- release decision rule tying RC status to provider-backed verification

### [ADR-005-persistence-model.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/docs/ADR-005-persistence-model.md)

Purpose:

- define when to migrate from JSON file persistence to SQLite/Postgres

Current role:

- persistence model decision with explicit migration triggers (>10K rows, multi-instance, cross-store joins)

### [ADR-006-secret-management.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/docs/ADR-006-secret-management.md)

Purpose:

- define when to migrate from environment variables to a dedicated secret store

Current role:

- secret management decision with explicit migration triggers (multi-operator, rotation, compliance, >15 secrets)

## Reading Order

If you are new to the service, use this order:

1. [README.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/README.md)
2. [MVP.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/MVP.md)
3. [API-CONTRACT-FREEZE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/API-CONTRACT-FREEZE.md)
4. [ADR-INDEX.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/docs/ADR-INDEX.md)
5. relevant ADR from this index

## Rule Going Forward

When a new durable decision is accepted:

1. add or update the ADR
2. update this index
3. update the canonical service map only if the decision changes service truth
