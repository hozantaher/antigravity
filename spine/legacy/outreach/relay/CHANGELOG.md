# Changelog

All notable changes to the anti-trace-relay service.

## [0.1.0] - 2026-04-03

### MVP Release

Privacy-hardened communication relay for persecuted individuals in conflict zones.
30 packages, 116 tests, Go stdlib only, single binary.

### Added

#### Core Pipeline (ADR-001)
- Content sanitization: HTML/script/tracking strip, UTF-8 normalization
- Identity vault with separate AES-256-GCM encryption key
- X25519 + HKDF-SHA256 + AES-256-GCM end-to-end content sealing
- 15-minute timestamp bucketing across all stored/logged data
- Fixed size-class padding (512B, 2K, 8K, 32K)
- In-process message bus (Go channels, zero network surface)
- Store-and-forward relay with crypto/rand delays (30-300s)
- Cover traffic (~30%) with Fisher-Yates shuffle
- Trusted-delivery exit boundary with channel verification
- Per-actor rate limiting (sliding window)
- Minimal audit trail (no content, no IPs, no real identities)

#### Transport Layer
- SOCKS5 proxy (RFC 1928 implementation, DNS resolved by proxy, fail-closed)
- Tor hidden service manager (auto torrc, Ed25519 v3 .onion keys, lifecycle management)
- WireGuard VPN manager (wg-quick, auto Curve25519 key generation, PSK support)
- Multi-hop transport chain: direct, tor, vpn, vpn+tor
- Bridge to privacy-gateway (intake endpoint forwarding)

#### Anti-State-Level Defenses (ADR-002)
- Constant-rate emission engine (Loopix model, zero jitter, fixed interval)
- Pool-based mixing (crypto/rand uniform selection, configurable anonymity set)
- Dead drop bulletin board (HMAC-derived slots, hourly epoch rotation, TTL expiry)
- Dead drop HTTP endpoints: POST/GET /v1/drop/{slotID} (unauthenticated by design)

#### Anti-Physical-Access Defenses (ADR-002)
- Amnesic submission client (PBKDF2 600K + HKDF, zero persistent state)
- Ephemeral memory management (mlock, SecureBuffer, WipeAll, signal-safe cleanup)
- Duress system (forensically indistinguishable from wrong password)
- One-shot submit binary (derive -> seal -> post -> zero -> exit in seconds)

#### Security Hardening
- TLS 1.3 only (X25519 curves)
- Constant-time bearer token authentication
- mTLS authenticator with composite auth
- Security headers (nosniff, DENY, no-store, HSTS, CSP, no-referrer)
- CORS rejection (all cross-origin requests blocked)
- Recipient validation (CRLF injection, control chars)
- Core dump prevention (RLIMIT_CORE=0)
- Memory wiping for all cryptographic material
- Secrets file support (alternative to env vars)
- Key rotation support (KeyRing with multi-key decrypt)

#### Deployment
- systemd unit with 26 security directives
- Dockerfile (multi-stage, alpine, non-root)
- Smoke test script (7 assertions)
- Deployment guide with 4 transport modes
- Environment and secrets templates

#### API Endpoints
- GET /healthz
- POST /v1/submit
- GET /v1/status
- GET /v1/audit-events
- GET /v1/exit-channels
- POST /v1/exit-channels
- GET /v1/identities
- POST /v1/drop/{slotID}
- GET /v1/drop/{slotID}

#### Delivery Modes
- record-only (testing, no outbound)
- bridge (forward to privacy-gateway intake)
- smtp (direct SMTP via anonymized transport)
- deaddrop (constant-rate emission + pool mixing + dead drop)

### Verified
- 116 unit/integration tests across 22 packages, -race clean
- Smoke test: 7/7 pass (record-only mode)
- Dead drop E2E: submit -> pool -> emit -> dead drop -> poll (pass)
- Amnesic submit E2E: passphrase -> derive -> seal -> post -> poll -> zero state (pass)
- Cross-service E2E: ATR -> bridge -> privacy-gateway intake (pass)
- SMTP delivery E2E: alias -> message -> MailHog (pass, privacy headers absent)

### Known Limitations
- File-based storage (not suitable for high-volume production)
- Single-node (no HA/clustering)
- PBKDF2 instead of Argon2id (stdlib constraint)
- Go TLS fingerprint identifiable (mitigated inside Tor circuit)
- Intersection attacks possible with small user base
