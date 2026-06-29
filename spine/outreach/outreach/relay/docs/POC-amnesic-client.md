# POC: Amnesic Client Deployment Practicality

## Status: Deferred (needs real user testing)

## Hypothesis

The zero-state CLI client (`cmd/submit`) is practical for real users in its target scenario (persecuted individuals, conflict zones).

## Scope

- In scope: onboarding friction measurement (how many steps, how many errors)
- In scope: error rate with real passphrase-based workflow
- In scope: deployment scenarios (pre-built binary, USB stick, ephemeral VM)
- Out of scope: formal security audit of amnesic properties (separate scope)

## Current Implementation

```bash
echo "passphrase" | ./submit \
  --relay https://relay.example.com \
  --recipient-key <64-char-hex-x25519-pubkey> \
  --message "Help"
```

Properties:
- All keys derived from passphrase via PBKDF2 (600K iterations) + HKDF
- X25519 key exchange for E2E encryption
- Zero files on disk (process exits, nothing persists)
- Secure memory: mlock, WipeAll registry, signal-safe cleanup
- Duress: wrong passphrase = forensically identical to duress scenario

## Success Signal

A non-technical user can:
1. Receive the binary and a recipient public key (e.g., printed on paper)
2. Successfully send a message on first or second attempt
3. Verify that no files remain after the process exits
4. Complete the entire workflow in under 2 minutes

## Failure Signal

- Users consistently mistype the 64-char hex key (error rate >50%)
- Passphrase entry via pipe is confusing (users try interactive mode)
- Binary distribution is impractical (platform mismatch, unsigned binary warnings)
- Error messages are too cryptic for non-technical users

## Prerequisites

1. Bridge MVP path proven (message delivery works end-to-end)
2. At least one real test user (not the developer)
3. Pre-built binaries for Linux arm64 and amd64

## Open Questions

1. Should the recipient key be shortened (e.g., Bech32 encoding instead of raw hex)?
2. Should there be a QR code or NFC-based key exchange option?
3. Is stdin pipe the right UX, or should there be an interactive prompt (with secure terminal handling)?

## Decision

**Deferred** — Cannot evaluate practicality without real user testing. The implementation exists and is technically sound. The open questions about key format and input method should be resolved during user testing, not before.

## Review Date: After bridge MVP proven and a test user is available.
