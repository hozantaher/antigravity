# ADR-005: Verification Boundary for a Credible Release Track

**Status:** Accepted
**Date:** 2026-04-04
**Authors:** Spec Kit Codex Stack core council
**Scope:** `services/anti-trace-relay/` verification posture, release credibility, and mode-specific evidence requirements

---

## 1. Context

`anti-trace-relay` now has multiple forms of evidence:

- stable local `go test ./...` verification
- local smoke and handler coverage
- a cross-service bridge report with `privacy-gateway`
- a live deployment report demonstrating dead-drop and amnesic submitter flow

That is valuable, but it still leaves an important ambiguity:

- which evidence is sufficient for a credible release-track claim
- whether all delivery modes need the same verification depth
- which modes can remain local or experimental without blocking the near-term release posture

Without this decision, the service risks mixing:

- engineering confidence
- architecture plausibility
- release credibility

Those are not the same thing.

---

## 2. Decision Drivers

| Driver | Weight | Rationale |
|--------|--------|-----------|
| Honest release posture | Critical | The service must not imply more proof than it has |
| Alignment with primary path | Critical | Verification should match the chosen MVP path |
| Cost realism | High | Not every advanced mode needs release-grade verification immediately |
| Cross-service coherence | High | `bridge -> privacy-gateway` is now the primary near-term path |
| Experimental discipline | High | Dead-drop and stronger anti-analysis mechanics should not silently bypass proof requirements |

---

## 3. Decision

We define the verification boundary as follows.

### 3.1 Baseline Engineering Confidence

The following are required for any credible ongoing development state:

- local `go test ./...` is green in the stabilized default path
- default HTTP/API test coverage is green
- record-only local operation is usable for development and smoke work

This is necessary, but not sufficient, for a release-quality claim.

### 3.2 Near-Term Release Credibility Depends on the Primary Path

Because ADR-004 defines `bridge -> privacy-gateway intake` as the primary near-term MVP path, the first credible release-track demonstration must prove that path end-to-end.

That means the minimum credible release-track evidence is:

1. authenticated submitter request accepted by `anti-trace-relay`
2. relay pipeline sanitizes, identity-separates, and forwards through `bridge`
3. `privacy-gateway` intake accepts the bridged submission
4. resulting downstream submission is visible in the expected operator/read-model surfaces
5. the combined flow is recorded in a cross-service verification artifact

### 3.3 What Counts as Sufficient for the First Credible Milestone

For the first credible milestone, all of these must be true:

- local engineering verification passes
- cross-service bridge verification passes against a real running `privacy-gateway` target
- the bridge path remains coherent with the downstream intake/store-and-forward boundary
- audit and operator evidence do not leak content, IPs, or real identities

If these are true, the service can honestly claim a credible near-term release track for its primary MVP path.

### 3.4 Direct SMTP Is Secondary Evidence

Direct `smtp` does not need to block the first credible release-track posture.

It may remain:

- implemented
- documented
- locally testable

But it is not required to be the first release-grade proof point.

If later promoted, it should receive its own stronger verification expectations.

### 3.5 Deaddrop Is Valuable, But Not the First Release Gate

`deaddrop` evidence remains important, but it is not the gating proof for the primary near-term release posture.

This means:

- the existing live dead-drop report is useful evidence
- it demonstrates architectural and operational plausibility
- but it does not by itself define the first release-quality boundary for the service

Further dead-drop confidence should be treated as explicit `POC` or later-phase verification work unless promoted.

---

## 4. Consequences

### Positive

- release credibility is now tied to the path the service actually prioritizes
- the service no longer needs equal proof for every mode before moving forward
- dead-drop work can stay ambitious without silently becoming a release blocker
- cross-service work with `privacy-gateway` gains clearer strategic importance

### Negative

- some existing live deaddrop evidence becomes clearly “strong supporting evidence” rather than the main release gate
- direct SMTP is intentionally de-emphasized in near-term release sequencing

---

## 5. Operational Rule

Going forward:

- treat local test success as engineering readiness, not release proof
- treat cross-service bridge verification as the primary near-term release gate
- treat deaddrop verification as advanced supporting evidence unless explicitly promoted
- do not claim a strong release posture from deaddrop-only or local-only success

---

## 6. Documentation Rule

Canonical and near-canonical docs should reflect this hierarchy:

- local tests = development confidence
- bridge verification = primary release evidence
- deaddrop live run = important supporting evidence
- direct SMTP = secondary mode, not first release gate

---

## 7. Alternatives Considered

### Alternative 1: Require equal live proof for `bridge`, `smtp`, and `deaddrop`

Rejected.

Too expensive, too broad for the current maturity level, and mismatched with the chosen primary path.

### Alternative 2: Let deaddrop live deployment define the release boundary

Rejected.

Important evidence, but it proves the wrong near-term path for the newly chosen mode hierarchy.

### Alternative 3: Use only local tests as the release threshold

Rejected.

Good engineering hygiene, but too weak for a credible privacy-sensitive release claim.

---

## 8. Follow-On Work

This ADR implies the next useful steps are:

1. refresh `README` and doc map with the verification hierarchy
2. tighten or refresh the cross-service verification artifact if needed
3. keep dead-drop advancement on explicit `POC` or later-phase tracks unless promoted
