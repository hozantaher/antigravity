# Deployment Modes

## Purpose

This is the shortest guide for choosing an operating mode for the service.

Use it when you need to answer:

- which transport mode fits the current environment
- which retention profile should be paired with that mode
- what the recommended first progression path looks like

## The Four Practical Modes

### Mode A: Local Rehearsal

Transport posture:

- `DELIVERY_MODE=record-only`
- no IMAP configuration

Retention profile:

- use [Dev](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/.env.profile.dev.example)

Use when:

- developing locally
- testing API contracts
- verifying persistence and restart behavior

What it proves:

- alias flow works
- submissions and legacy message flow work locally
- outbox recording works
- local state survives restart

What it does not prove:

- real SMTP delivery
- real IMAP sync
- provider-specific auth and mailbox behavior

### Mode B: Outbound Verification

Transport posture:

- `DELIVERY_MODE=smtp`
- SMTP configured
- IMAP still disabled

Retention profile:

- use [Small Team](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/.env.profile.small-team.example)

Use when:

- first real relay-backed outbound testing starts
- the team wants to validate delivery before enabling inbound sync

What it proves:

- real SMTP relay wiring works
- alias domain strategy is acceptable to the provider
- provider-backed outbound path behaves as expected

What it does not prove:

- inbound normalization
- IMAP cursor advancement
- end-to-end provider-backed roundtrip

### Mode C: Full Relay Staging

Transport posture:

- `DELIVERY_MODE=smtp`
- SMTP configured
- IMAP configured

Retention profile:

- use [Small Team](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/.env.profile.small-team.example)

Use when:

- a shared staging or operator-run environment is validating the full flow
- the team needs real outbound and inbound behavior together

What it proves:

- outbound relay works
- inbound sync works
- IMAP cursor state advances
- operator read models are usable in a provider-backed environment

What it does not prove:

- long-term production governance
- production incident handling
- strictest data-minimization posture

### Mode D: Privacy-Strict Operation

Transport posture:

- `DELIVERY_MODE=smtp`
- SMTP configured
- IMAP configured only if truly needed

Retention profile:

- use [Privacy-Strict](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/.env.profile.privacy-strict.example)

Use when:

- the environment prioritizes data minimization over long operator history
- the team is ready for short-lived audit and submission visibility

What changes operationally:

- audit history disappears faster
- inactive identity links are pruned sooner
- old terminal submissions are pruned sooner
- stale IMAP cursors do not remain long once unused

Operational warning:

- this mode should be chosen deliberately
- shorter retention means shorter investigation windows

## Recommended Progression Path

Use this order unless there is a strong reason not to:

1. `Local Rehearsal`
2. `Outbound Verification`
3. `Full Relay Staging`
4. `Privacy-Strict Operation`

Why this order:

- it isolates transport problems gradually
- it avoids mixing provider issues with local contract issues too early
- it lets the team tighten retention only after the full flow is already understood

## Mode-To-Profile Matrix

| Operating Need | Transport | Retention Profile |
|---|---|---|
| local development | `record-only` | `Dev` |
| first provider SMTP checks | `smtp` | `Small Team` |
| shared staging with inbound sync | `smtp + imap` | `Small Team` |
| minimized data footprint | `smtp` or `smtp + imap` | `Privacy-Strict` |
| temporary incident analysis | current transport | `Investigation Window` |

## Safe Defaults

If you want the simplest sensible mapping:

- local machine: `Local Rehearsal`
- shared non-production environment: `Full Relay Staging`
- privacy-sensitive shared environment: `Privacy-Strict Operation`

## Cross-References

For transport setup details, see:

- [OPERATOR-GUIDE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/OPERATOR-GUIDE.md)
- [FASTMAIL-RUN-SHEET.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/FASTMAIL-RUN-SHEET.md)

For retention profile details, see:

- [RETENTION-CONFIGURATION-COOKBOOK.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RETENTION-CONFIGURATION-COOKBOOK.md)
- [ENV-PROFILES.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/ENV-PROFILES.md)
