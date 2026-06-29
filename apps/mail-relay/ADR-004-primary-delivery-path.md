# ADR-004: Primary MVP Delivery Path and Mode Hierarchy

**Status:** Accepted
**Date:** 2026-04-04
**Authors:** Spec Kit Codex Stack core council
**Scope:** `services/anti-trace-relay/` delivery modes, release posture, and near-term product sequencing

---

## 1. Context

`anti-trace-relay` currently exposes several delivery modes:

- `record-only`
- `bridge`
- `smtp`
- `deaddrop`

That flexibility is architecturally useful, but it creates product ambiguity.

Without an explicit hierarchy, the service appears to have several equally primary MVP paths, even though they are not equally mature, equally verifiable, or equally cheap to operate.

This ambiguity creates three problems:

1. implementation effort can spread across too many modes at once
2. verification posture becomes unclear
3. more speculative anti-analysis mechanisms can accidentally look productized before they are proven

The service now needs one durable answer for:

- which mode is the primary near-term MVP path
- which modes are secondary deployment options
- which modes should still be treated as experimental or POC-shaped

---

## 2. Decision Drivers

| Driver | Weight | Rationale |
|--------|--------|-----------|
| Honest product positioning | Critical | The service must not imply maturity it does not yet have |
| Verification tractability | Critical | The primary path must be realistically verifiable |
| Reuse of existing proven stack | High | `privacy-gateway` already provides a stronger downstream operator and audit surface |
| Scope control | High | The next phase must narrow focus, not widen it |
| Privacy preservation | High | The chosen path must still preserve the core anti-trace intake goals |
| Deployment flexibility | Medium | Other modes remain useful even if not primary |

---

## 3. Decision

We define the near-term mode hierarchy as follows:

### 3.1 Primary MVP Path: `bridge`

`bridge -> privacy-gateway intake` is the primary near-term MVP delivery path.

This means:

- the preferred operational story is:
  - anti-trace intake
  - sanitization and identity separation
  - privacy-hardened boundary handling
  - bridge into `privacy-gateway` secure intake and submission flow
- the first serious release-quality path should optimize for this cross-service chain
- operator guidance and future verification work should treat this as the main delivery narrative

### 3.2 Secondary Mode: `smtp`

Direct `smtp` remains a supported delivery mode, but it is not the primary near-term MVP path.

This means:

- it remains useful for deployments that cannot rely on `privacy-gateway`
- it is still part of the architecture and runtime surface
- it should not drive the main roadmap ahead of `bridge`

### 3.3 Experimental / POC-Shaped Mode: `deaddrop`

`deaddrop` remains strategically important, but it is not treated as the primary MVP flow.

This means:

- it should be handled as a higher-uncertainty capability
- stronger claims about dead-drop operational readiness should require dedicated proof
- future work around dead-drop credibility, constant-rate economics, and real operator usability belongs on explicit `POC` tracks unless promoted later

### 3.4 Local Safety Mode: `record-only`

`record-only` remains the safe local and test mode.

It is not a delivery product path, but it remains essential for:

- local verification
- sandbox-safe development
- deterministic smoke testing

---

## 4. Consequences

### Positive

- roadmap focus becomes much clearer
- the service can reuse `privacy-gateway` as the stronger downstream delivery and operator surface
- cross-service verification becomes a natural next milestone
- advanced anti-analysis work stays honest about maturity

### Negative

- some users may expect direct `smtp` to remain co-equal in planning priority
- `deaddrop` will feel intentionally de-emphasized in near-term product sequencing
- documentation must be careful to distinguish architectural availability from primary path status

---

## 5. Operational Meaning

Going forward:

- new near-term product work should assume `bridge` is the preferred path
- cross-service verification with `privacy-gateway` should be treated as the most credible release-track demonstration
- `smtp` improvements should be selective and justified
- `deaddrop` improvements should be framed as explicit experiments or later-phase product work unless their maturity level changes

---

## 6. Documentation Rule

Canonical and near-canonical docs should now describe the mode hierarchy this way:

- `bridge` = primary near-term MVP path
- `smtp` = secondary supported mode
- `deaddrop` = experimental or higher-uncertainty path unless explicitly promoted later
- `record-only` = local safety and testing mode

This ADR does **not** remove any mode from the current runtime surface.

It only defines their planning and product priority.

---

## 7. Alternatives Considered

### Alternative 1: Keep `bridge`, `smtp`, and `deaddrop` as co-equal MVP paths

Rejected.

This preserves architectural flexibility, but keeps product ambiguity and makes verification posture much harder to explain honestly.

### Alternative 2: Make direct `smtp` the primary path

Rejected.

Direct SMTP is useful, but the strongest downstream operator and audit model now lives in `privacy-gateway`. Using the bridge path as primary creates a more coherent near-term story.

### Alternative 3: Make `deaddrop` the primary path immediately

Rejected.

Strategically compelling, but still too uncertain operationally to be treated as the main near-term MVP path without more explicit proof.

---

## 8. Follow-On Work

This ADR implies the next useful steps are:

1. define the verification boundary for a credible `anti-trace-relay` release track
2. align README and planning docs with the mode hierarchy
3. treat dead-drop maturity questions as explicit `POC` work rather than implied product truth
