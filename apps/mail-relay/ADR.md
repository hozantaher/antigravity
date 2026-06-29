# ADR-001: Anti-Trace Relay -- MVP Architecture Decision Record

**Status:** Accepted
**Date:** 2026-04-03
**Authors:** Spec Kit Codex Stack core council
**Scope:** `services/anti-trace-relay/` -- privacy-hardened communication relay for persecuted individuals in conflict zones

---

## 1. Context and Problem Statement

People persecuted in conflict zones need a way to submit sensitive communications without exposing their identity, location, or communication patterns to adversaries. Standard email and messaging systems leak metadata (IP addresses, timestamps, device fingerprints, routing headers) that can be used to identify and locate senders.

The existing `privacy-gateway` provides privacy-first email relay with alias management, but lacks:
- Intake anonymization (no Tor/VPN support)
- Traffic analysis resistance (no cover traffic, no timing obfuscation)
- End-to-end content protection (content readable by relay operator)
- Network-level anonymization (direct connections expose operator IP)
- Identity vault isolation (shared encryption key with transport data)

We need a dedicated relay service that provides defense-in-depth against network surveillance, timing analysis, content inspection, and identity correlation.

### MVP Goal

By MVP release, one authenticated actor can:
1. Submit a message through a privacy-hardened intake (web API or .onion hidden service)
2. Have that message sanitized, identity-separated, encrypted, and queued with random delay
3. Observe audit events for their submissions (with no content or identity leakage in the audit trail)
4. Register and list exit channels for verified delivery
5. Have messages relayed through an anonymized transport chain (Tor/VPN/both)

### What MVP Is NOT

- Not "untraceable" or "anonymous" -- honest about limitations
- Not a mixnet or onion routing network
- Not a replacement for Signal, Briar, or Tor Browser
- Not a censorship circumvention tool (though it can assist)

---

## 2. Decision Drivers

| Driver | Weight | Rationale |
|--------|--------|-----------|
| Identity protection | Critical | Submitter identity must never leak to transport layer |
| Metadata minimization | Critical | Timestamps, sizes, ordering must resist correlation |
| Operator trust minimization | High | Operator cannot read sealed content |
| Self-contained deployment | High | No external dependencies beyond Tor binary |
| Existing pattern reuse | High | Same Go stdlib patterns as privacy-gateway |
| Honest threat model | High | Must not overclaim protection guarantees |
| Abuse prevention | Medium | Rate limiting and content policy without compromising privacy |
| Operational simplicity | Medium | Single binary, env var config, file-based storage |

---

## 3. Considered Alternatives

### A. Extend privacy-gateway with anti-trace features
**Rejected.** Privacy-gateway has a different trust model (operator sees content), different API contract (frozen for MVP), and mixing concerns would complicate both codebases. Separation of concerns wins.

### B. Use external mixnet (Nym, HOPR)
**Rejected.** Adds external dependency, requires token economics, limited Go stdlib support, and increases operational complexity beyond MVP scope.

### C. Build as a library/middleware for privacy-gateway
**Rejected.** The anti-trace pipeline (intake -> sanitize -> seal -> delay -> batch -> exit) is a fundamentally different message flow than privacy-gateway's synchronous submission model. A separate service with optional bridge is cleaner.

### D. Build as a standalone relay service (chosen)
**Accepted.** Clean separation of concerns, independent deployment, optional bridge to privacy-gateway for delivery, reuses proven Go patterns from the existing codebase.

---

## 4. Architecture Overview

### 4.1 System Layers

```
SUBMITTER
    |
[INTAKE LAYER] ---- TLS 1.3 (clearnet) or Tor hidden service (.onion)
    |
[SANITIZER] ------- Strip HTML, scripts, tracking, control chars
    |
[IDENTITY VAULT] -- Opaque alias token issued; real identity encrypted with VAULT key
    |
[METADATA MIN] ---- Timestamp bucketed to 15-min; content padded to size class
    |
[CONTENT SEAL] ---- X25519 + HKDF-SHA256 + AES-256-GCM (recipient key)
    |
[MESSAGE BUS] ----- In-process Go channels (topic: "sealed")
    |
[RELAY SCHEDULER] - Random delay 30-300s via crypto/rand; persisted queue
    |
[BATCH DRAINER] --- Collect ready envelopes + ~30% cover traffic
    |
[FISHER-YATES] ---- Cryptographic shuffle (crypto/rand)
    |
[EXIT BOUNDARY] --- Verify channel is registered + trusted
    |
[TRANSPORT CHAIN] - direct | tor | vpn | vpn+tor
    |
[DELIVERY] -------- SMTP (via anonymized transport) or record-only
    |
[AUDIT] ----------- Minimal: event_type + envelope_id + bucketed_timestamp
```

### 4.2 Package Map (24 packages)

| Layer | Package | Component | ADR Section |
|-------|---------|-----------|-------------|
| Foundation | `model` | Domain types | 5.1 |
| Foundation | `config` | Env vars + secrets file | 5.2 |
| Foundation | `filestore` | AES-256-GCM codec + key rotation | 5.3 |
| Foundation | `minlog` | Privacy-safe logger | 5.4 |
| Foundation | `auth` | Bearer token (constant-time) + mTLS | 5.5 |
| Pipeline | `sanitizer` | Content/metadata sanitization | 5.6 |
| Pipeline | `vault` | Identity vault (separate key) | 5.7 |
| Pipeline | `identity` | Identity separation facade | 5.7 |
| Pipeline | `metamin` | Timestamp bucketing + size-class padding | 5.8 |
| Pipeline | `contentenc` | X25519 + HKDF + AES-256-GCM | 5.9 |
| Pipeline | `msgbus` | In-process channel pub/sub | 5.10 |
| Relay | `relay` | Store-and-forward scheduler | 5.11 |
| Relay | `traffic` | Cover traffic + batch drainer + shuffle | 5.12 |
| Relay | `boundary` | Trusted-delivery exit verification | 5.13 |
| Relay | `abuse` | Per-actor rate limiter | 5.14 |
| Relay | `audit` | Minimal audit trail | 5.15 |
| Transport | `transport` | SOCKS5 + direct + chain | 5.16 |
| Transport | `onion` | Tor hidden service manager | 5.17 |
| Transport | `vpn` | WireGuard VPN manager | 5.18 |
| Integration | `intake` | Pipeline orchestrator | 5.19 |
| Integration | `httpapi` | HTTP server + security middleware | 5.20 |
| Integration | `delivery` | SMTP via anonymized transport | 5.21 |
| Integration | `bridge` | Privacy-gateway forwarding | 5.22 |
| Deployment | `deploy/` | systemd, Docker, env templates | 5.23 |

---

## 5. Detailed Decisions

### 5.1 Domain Model

**Decision:** Single `model` package with flat types, no inheritance.

**Types:**
- `Envelope` -- core message unit flowing through pipeline. Fields: ID (`env_` prefix), AliasToken, TenantID, SealedContent, SizeClass, BucketedAt, IntakeChannel, Status, ScheduledAt, IsCover.
- `AliasMapping` -- opaque token to encrypted identity reference. Encrypted with vault-specific key.
- `AuditEntry` -- event_type + envelope_id + bucketed_timestamp. No content, no IP, no real identity.
- `ExitChannel` -- verified outbound delivery target (smtp/webhook/drop).
- `Actor` -- authenticated user with ID + TenantID.
- `IntakeRequest` -- raw submission (recipient, subject, body, optional recipient key).
- `SanitizationResult` -- sanitization outcome with status and notes.

**Rationale:** Privacy-gateway uses the same flat-model pattern. Types are serializable to JSON for file-based persistence. Status constants define the envelope lifecycle.

**Lifecycle:**
```
accepted -> sanitized -> sealed -> scheduled -> relayed | failed | blocked
```

### 5.2 Configuration

**Decision:** Environment variables with optional secrets file (`SECRETS_FILE` env var).

**Required at startup (fatal if missing):**
| Variable | Purpose |
|----------|---------|
| `DATA_ENCRYPTION_KEY_B64` | 32-byte AES key for relay/audit data |
| `VAULT_ENCRYPTION_KEY_B64` | 32-byte AES key for identity vault |
| `DEV_API_TOKEN` | API authentication (no default) |
| `TLS_CERT_FILE` | TLS certificate |
| `TLS_KEY_FILE` | TLS private key |

**Secrets file** (`config/secrets.go`): key=value format, 0600 permissions, loaded before env vars (env vars take precedence). Avoids sensitive data in process environment visible via `/proc/[pid]/environ`.

**Rationale:** Same env-var pattern as privacy-gateway. Secrets file adds operational security without external dependencies (no Vault/KMS for MVP).

### 5.3 Storage and Encryption

**Decision:** File-based JSON with AES-256-GCM encryption at rest. Atomic writes (temp file + rename). Two separate encryption keys.

**Key separation:**
| Key | Scope | Compromise impact |
|-----|-------|-------------------|
| `DATA_ENCRYPTION_KEY_B64` | relay queue, audit events, exit channels | Messages are already sealed; audit has no content |
| `VAULT_ENCRYPTION_KEY_B64` | identity vault mappings | Real identity to alias token mapping exposed |

**Rationale:** Compromising the data key does not expose real identities. Compromising the vault key does not expose message content (already E2E sealed). Both keys must be compromised simultaneously for full de-anonymization.

**Key rotation** (`filestore/keyrotation.go`): `KeyRing` supports multiple keys indexed by ID. `RotateFile()` re-encrypts from any known key to current key. Not automated in MVP -- operator runs rotation manually.

**Files created at runtime:**
```
vault-mappings.json   -- encrypted with VAULT key
audit-events.json     -- encrypted with DATA key
relay-queue.json      -- encrypted with DATA key
exit-channels.json    -- encrypted with DATA key
```

### 5.4 Minimal Logging

**Decision:** Custom logger that refuses to log content, IPs, real identities, or precise timestamps.

**Redaction rules (enforced in `minlog.F()`):**
- Keys matching: ip, addr, email, identity, content, body, subject, password, secret, token, key
- Values matching email pattern (`@` + `.`)
- Values matching IPv4 (`a.b.c.d` with digits) or IPv6 (`::` or 2+ colons)
- All timestamps truncated to 15-minute boundaries via `BucketedTime()`

**Allowed in logs:** event types, envelope IDs, alias tokens, size classes, error categories, bucketed timestamps.

**Rationale:** Standard `log` package would leak sensitive data. The minlog approach makes it structurally impossible to accidentally log an IP address or email, even under pressure to add debug logging.

### 5.5 Authentication

**Decision:** Constant-time bearer token auth with optional mTLS upgrade path.

**Static token auth:** Uses `crypto/subtle.ConstantTimeCompare` against all registered tokens to prevent timing oracle. Iterates all entries regardless of match.

**mTLS auth:** `MTLSAuthenticator` extracts actor from client certificate CN. `CompositeAuthenticator` tries mTLS first, falls back to bearer token.

**Rationale:** Bearer tokens are simple for MVP. mTLS eliminates token theft as an attack vector for production. Composite auth enables gradual migration.

### 5.6 Content Sanitization

**Decision:** Multi-stage sanitization pipeline that strips identifying metadata.

**Stages:**
1. UTF-8 validation and repair
2. Control character removal (preserve \n, \t)
3. **Blocked content detection** (`<script>`, `javascript:`, `data:text/html`, `vbscript:`) -- rejects submission
4. HTML tag stripping
5. Tracking pattern removal (1x1 pixels, utm_*, beacon)
6. Whitespace normalization

**Header sanitization** (`StripHeaders`): Removes `x-originating-ip`, `x-mailer`, `user-agent`, `x-forwarded-for`, `x-real-ip`, `received`, `x-sender`, `x-source`, `x-authenticated`, `x-client`, `x-device`.

**Rationale:** Order matters -- blocked content check happens on raw input before HTML stripping, so `<script>` embedded in benign HTML is caught. Sanitization runs before identity separation to ensure no identifying metadata reaches the vault or transport.

### 5.7 Identity Separation and Vault

**Decision:** Real identity stored ONLY in the vault. Pipeline uses opaque 32-char hex alias tokens.

**Vault interface:**
```go
type Vault interface {
    Register(ctx, tenantID, realIdentityRef, purpose) (aliasToken, error)
    Resolve(ctx, aliasToken) (realIdentityRef, error)  // restricted
    Revoke(ctx, aliasToken) error
    ListByTenant(ctx, tenantID) ([]AliasMapping, error)
}
```

**Implementation:** `FileVault` with dedicated encryption key. `EncryptedRef` field stores real identity encrypted with vault codec. Listing never exposes `EncryptedRef`. Supports TTL and revocation.

**Identity service facade:** Thin wrapper that exposes only `IssueAlias` and `RevokeAlias`. No `Resolve` in the normal pipeline -- resolution is only for authorized operator access.

**Rationale:** This is the core anti-trace mechanism. Even if the relay queue, audit trail, and transport layer are all compromised, the adversary only sees opaque alias tokens. The real identity mapping requires the vault encryption key AND vault file access.

### 5.8 Metadata Minimization

**Decision:** Two mechanisms -- timestamp bucketing and fixed-size padding.

**Timestamp bucketing:** All timestamps truncated to 15-minute boundaries (`time.Truncate(15 * time.Minute)`). Applied to: envelope `BucketedAt`, audit `BucketedAt`, vault `CreatedBucket`, all log timestamps.

**Size-class padding:** Content padded to one of 4 size classes: 512B, 2048B, 8192B, 32768B. Padding format: `[4-byte big-endian length][original data][random padding to fill class]`. All envelopes in the same class are indistinguishable by size.

**Rationale:** Precise timestamps enable timing correlation. Variable sizes enable content fingerprinting. Bucketing reduces timing precision to 15-minute windows. Fixed padding ensures all "small messages" look identical to all other "small messages" regardless of content.

### 5.9 Content Protection

**Decision:** X25519 key agreement + HKDF-SHA256 + AES-256-GCM envelope encryption.

**Key derivation:**
```
shared_secret = X25519(ephemeral_private, recipient_public)
info = ephemeral_public || recipient_public
aes_key = HKDF-SHA256(shared_secret, salt="anti-trace-relay-content-enc-v1", info)
```

**Ciphertext format:** `[32B ephemeral pubkey][12B nonce][ciphertext + 16B tag]`

**Memory safety:** Shared secrets and AES keys explicitly zeroed with `wipeBytes()` after use to prevent heap persistence.

**Rationale:** HKDF with context binding prevents key confusion attacks (vs. raw SHA-256). Ephemeral keys ensure forward secrecy -- compromising the recipient key doesn't retroactively decrypt past messages (each message uses a fresh ephemeral key). The relay operator cannot read sealed content even with full access to the data encryption key.

### 5.10 Internal Message Bus

**Decision:** In-process Go channel-based pub/sub. No external broker.

**Topics:** `intake.accepted`, `sanitized`, `sealed`, `scheduled`, `relay.ready`

**Buffer:** 128 messages per topic (configurable). Non-blocking publish -- drops if subscriber is full to prevent pipeline stalls.

**Rationale:** External brokers (Redis, RabbitMQ, NATS) expand the attack surface and add network-observable communication patterns. In-process channels are invisible to network observers and have zero latency.

### 5.11 Store-and-Forward Relay

**Decision:** Envelopes persisted to encrypted file, scheduled for future delivery with random delay.

**Delay:** `crypto/rand` duration between `RELAY_MIN_DELAY_SECONDS` (default 30) and `RELAY_MAX_DELAY_SECONDS` (default 300).

**Persistence:** Envelopes survive process restart. Automatic retention-based pruning.

**Rationale:** Random delay breaks the temporal correlation between intake and delivery. Without delay, an observer who sees a submission at T and an outbound message at T+50ms can correlate them. With 30-300s random delay, the correlation window expands to 5 minutes with uniform distribution.

### 5.12 Traffic Analysis Resistance

**Decision:** Three mechanisms combined -- cover traffic, batch draining, and cryptographic shuffle.

**Cover traffic:** `CoverGenerator` produces dummy envelopes indistinguishable from real ones (same size classes, random content, `IsCover=true`). Default ratio: ~30% of each batch.

**Batch draining:** Ready envelopes collected in batches (interval: `BATCH_INTERVAL_SECONDS` +/- 25% crypto jitter). Cover traffic added. Batch shuffled using Fisher-Yates with `crypto/rand`.

**Jitter:** Batch interval is not fixed. Each iteration adds `crypto/rand` jitter of +/- 25% to prevent interval-based correlation.

**Rationale:** Without cover traffic, an observer can correlate batch sizes with intake volume. Without shuffle, the order of outbound messages correlates with intake order. Without jitter, the batch timing is predictable. Combined, these make traffic analysis significantly harder (though not impossible against a persistent state-level adversary with long-term statistical analysis).

### 5.13 Trusted-Delivery Boundary

**Decision:** Messages can only exit through pre-registered, verified exit channels.

**Channel types:** `smtp`, `webhook`, `drop` (local storage only).

**Verification:** Channels must be explicitly verified (`VerifyChannel`) before they can be used for delivery. Unverified channels are rejected.

**Rationale:** Prevents an attacker who compromises the API from redirecting messages to arbitrary destinations. Exit channels are a managed set controlled by the operator.

### 5.14 Abuse Prevention

**Decision:** Per-actor sliding-window rate limiter. No content-based filtering beyond sanitizer.

**Window:** 1 minute. Default: 10 submissions/minute/actor.
**Cleanup:** Stale windows pruned every 5 minutes.

**Rationale:** Rate limiting prevents abuse without requiring content inspection (which would compromise privacy). The limiter uses actor ID (not IP address, which would leak network identity).

### 5.15 Audit Trail

**Decision:** Minimal audit entries with NO content, NO IPs, NO real identities. Only: event_type, envelope_id, bucketed_timestamp.

**Event types:** `intake_accepted`, `sanitized`, `identity_issued`, `sealed`, `relay_scheduled`, `relay_completed`, `relay_failed`, `blocked`, `identity_revoked`.

**Data race fix:** Pruning runs under write lock (`mu.Lock()`), listing under read lock (`mu.RLock()`). Previous implementation had a data race (pruning under read lock).

**Rationale:** Audit is necessary for abuse investigation and operational health, but traditional audit trails (IP, user agent, content hash) are precisely the metadata we're trying to protect. Our audit tells the operator "an envelope was accepted and relayed" without revealing who, what, or when (beyond 15-minute buckets).

### 5.16 SOCKS5 Transport

**Decision:** Stdlib-only RFC 1928 SOCKS5 implementation. DNS resolved by proxy. Fail-closed.

**SOCKS5 handshake:** VER=0x05, no auth, CONNECT command with ATYP=0x03 (domain name).

**DNS safety:** Using ATYP=0x03 means the proxy (Tor) resolves DNS, not our process. This prevents DNS leakage that would reveal which domains the relay communicates with.

**Fail-closed:** If SOCKS5 proxy is unreachable, returns `ErrProxyUnreachable`. Never falls back to direct connection.

**Rationale:** External dependency (`golang.org/x/net/proxy`) adds supply chain risk. RFC 1928 is simple enough to implement correctly in ~80 lines. Fail-closed prevents accidental identity exposure if Tor goes down.

### 5.17 Tor Hidden Service

**Decision:** Managed Tor process with auto-generated torrc and Ed25519 v3 .onion keys.

**Key generation:** Ed25519 keypair via `crypto/ed25519`. Tor v3 key format (32B header + 64B expanded key). Public key derived to .onion address via base32 encoding.

**torrc hardening:**
```
SafeSocks 1
DisableDebuggerAttachment 1
ExitPolicy reject *:*
AvoidDiskWrites 1
```

**Lifecycle:** Start -> WaitReady (polls SOCKS5 port) -> serve -> Stop (SIGINT to Tor process).

**Onion listener:** Separate plain HTTP listener on localhost only (e.g. `127.0.0.1:8091`). Tor handles encryption. Intake channel set via context (`WithIntakeChannel` middleware), not from spoofable Host header.

**Rationale:** Tor hidden services provide end-to-end encrypted, NAT-traversing intake without exposing the relay's IP address. Auto-managed process eliminates manual torrc configuration errors.

### 5.18 WireGuard VPN

**Decision:** WireGuard tunnel via wg-quick (or manual ip/wg fallback). Auto-generated Curve25519 keypair.

**Config:** Generates wg-quick compatible `.conf` file with 0600 permissions. Supports PresharedKey for post-quantum resistance.

**Cleanup:** Config file (containing private key) deleted on shutdown.

**Transport:** Returns `AnonymousTransport` interface. Traffic routed through VPN tunnel via OS routing table (wg-quick sets AllowedIPs).

**Rationale:** VPN provides network-level anonymization independent of Tor. Useful where Tor is blocked or fingerprintable. WireGuard is fast, audited, and simple.

### 5.19 Transport Chain

**Decision:** Composable multi-hop transport with 4 modes.

| Mode | ISP Sees | VPN Sees | Destination Sees | Security Property |
|------|----------|----------|-----------------|-------------------|
| `direct` | Destination IP | N/A | Relay IP | Testing only |
| `tor` | Tor traffic | N/A | Tor exit IP | Network anonymity |
| `vpn` | VPN traffic | Destination IP | VPN IP | IP hiding |
| `vpn+tor` | VPN traffic | Tor traffic | Tor exit IP | Defense in depth |

**vpn+tor flow:**
```
Relay -> WireGuard VPN -> Tor Entry -> Tor Circuit -> Tor Exit -> Destination
```

**Rationale:** `vpn+tor` provides maximum privacy. VPN hides Tor usage from ISP (important in countries that fingerprint/block Tor). Tor hides destination from VPN server. No single party sees both origin and destination.

### 5.20 HTTP API

**Decision:** 7 endpoints with security middleware. TLS 1.3 only. X25519 curves.

**Endpoints:**
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/healthz` | No | Health check |
| `POST` | `/v1/submit` | Bearer | Submit intake request |
| `GET` | `/v1/status` | Bearer | Relay queue status |
| `GET` | `/v1/audit-events` | Bearer | Audit trail (tenant-scoped) |
| `GET` | `/v1/exit-channels` | Bearer | List exit channels |
| `POST` | `/v1/exit-channels` | Bearer | Register exit channel |
| `GET` | `/v1/identities` | Bearer | List identity mappings |

**Security headers:**
```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Cache-Control: no-store
Strict-Transport-Security: max-age=63072000; includeSubDomains
Content-Security-Policy: default-src 'none'
Referrer-Policy: no-referrer
```

**CORS:** All cross-origin requests rejected (403 if Origin header present).

**Body limits:** `maxBodyBytes` from config (default 32KB). `http.MaxBytesReader` enforced.

**Recipient validation:** CRLF injection check, control character check, domain format check via `delivery.ValidateRecipient()`.

### 5.21 SMTP Delivery

**Decision:** SMTP via anonymized transport. Minimal RFC 5322 headers. TLS 1.3 required.

**Minimal message:** Only From, To, Subject, MIME-Version, Content-Type headers. NO Date, Message-ID, X-Mailer, User-Agent, Received.

**Transport:** All SMTP connections routed through the configured `AnonymousTransport` (Tor SOCKS5 or VPN). DNS resolved by proxy to prevent leakage.

**Record mode:** `RecordDeliverer` captures delivery attempts in memory for testing without actual SMTP.

### 5.22 Privacy-Gateway Bridge

**Decision:** HTTP client bridge to forward relayed envelopes to privacy-gateway's `/v1/messages` endpoint.

**Flow:**
```
Submitter -> anti-trace-relay (intake, sanitize, seal, relay)
          -> PrivacyGatewayBridge
          -> privacy-gateway (alias, submission, SMTP delivery)
```

**Rationale:** Allows anti-trace-relay to handle the privacy-hardened intake/relay pipeline while privacy-gateway handles delivery with its established alias system, policy engine, and SMTP integration. The bridge is optional -- anti-trace-relay can deliver directly via its own SMTP deliverer.

### 5.23 Deployment

**Systemd unit** (`deploy/anti-trace-relay.service`): 26 security directives including `ProtectSystem=strict`, `NoNewPrivileges=yes`, `MemoryDenyWriteExecute=yes`, syscall filtering, `LimitCORE=0`.

**Docker** (`Dockerfile`): Multi-stage build, alpine runtime, non-root user (`antitrace:10001`), Tor included in image, data volume at `/app/data`.

**Startup safety:**
- Core dumps disabled (`syscall.Setrlimit`)
- Encryption keys required (fatal on empty)
- API token required (no guessable default)
- TLS cert+key required (no cleartext HTTP)

---

## 6. Honest Threat Model

### Protected Against (MVP)

| Threat | Mechanism | Strength |
|--------|-----------|----------|
| Casual network observer | TLS 1.3 + Tor/VPN | Strong |
| Server-side content disclosure | X25519+HKDF+AES-256-GCM E2E | Strong |
| Identity correlation via metadata | Vault isolation + separate key | Strong |
| Content fingerprinting via size | Fixed size-class padding | Strong |
| Basic timing analysis | Random delays + cover traffic + jitter | Moderate |
| Header/metadata leakage | Sanitizer + header stripping | Strong |
| IP address exposure | Tor .onion intake + SOCKS5 outbound | Strong |
| DNS leakage | SOCKS5 ATYP=0x03 domain resolution | Strong |
| Core dump key extraction | `RLIMIT_CORE=0` + `ProtectSystem=strict` | Strong |

### Partially Protected

| Threat | Limitation |
|--------|-----------|
| Advanced timing correlation | Statistical analysis over long periods can correlate intake/delivery patterns despite random delays |
| Volume analysis | Cover traffic helps but doesn't fully mask real traffic volume over time |
| Compromised operator | Can modify binary and observe pipeline, but cannot read sealed content without recipient key |
| Tor circuit correlation | Global adversary monitoring both entry and exit can correlate circuits (not specific to this system) |
| TLS fingerprinting | Go's TLS client hello is identifiable; mitigated when using Tor (fingerprint only visible to exit node) |

### NOT Protected

| Threat | Why |
|--------|-----|
| Compromised submitter endpoint | Outside system boundary |
| Compromised recipient endpoint | Outside system boundary |
| Rubber-hose cryptanalysis | No technical solution |
| State-level adversary with full network visibility and unlimited time | Statistical analysis eventually defeats timing resistance |
| Social engineering of operator | Operational, not technical |
| Side-channel attacks on server hardware | Requires physical security |

---

## 7. MVP Scope and Boundaries

### In Scope

- [x] Authenticated HTTP API (7 endpoints)
- [x] TLS 1.3 minimum with security headers
- [x] Content sanitization (HTML, scripts, tracking, control chars)
- [x] Identity vault with separate encryption key
- [x] Opaque alias tokens (real identity never in pipeline)
- [x] 15-minute timestamp bucketing
- [x] Fixed size-class padding (512B/2K/8K/32K)
- [x] X25519+HKDF+AES-256-GCM content sealing
- [x] In-process message bus
- [x] Store-and-forward with crypto/rand delays (30-300s)
- [x] Cover traffic (~30%) + Fisher-Yates shuffle
- [x] Jittered batch intervals (+/- 25%)
- [x] Tor hidden service manager (auto torrc, Ed25519 v3 keys)
- [x] WireGuard VPN manager (wg-quick, auto key generation)
- [x] Multi-hop transport chain (direct/tor/vpn/vpn+tor)
- [x] SOCKS5 transport (RFC 1928, DNS via proxy)
- [x] SMTP delivery via anonymized transport
- [x] Privacy-gateway bridge (optional forwarding)
- [x] Record-only delivery mode (testing)
- [x] Minimal audit trail (no content/IP/identity)
- [x] Per-actor rate limiting
- [x] Exit channel registration + verification
- [x] Constant-time token comparison
- [x] mTLS authenticator + composite auth
- [x] Key rotation support (KeyRing)
- [x] Secrets file loading
- [x] Core dump prevention
- [x] Memory wiping for crypto keys
- [x] Graceful shutdown with in-flight drain
- [x] systemd unit with 26 security directives
- [x] Dockerfile (multi-stage, non-root)
- [x] Smoke test script
- [x] 32 unit/integration tests with race detector

### Out of Scope (Post-MVP)

- Multi-tenant admin UI
- Persistent database backend (PostgreSQL/SQLite)
- HSM/KMS key management
- Automated key rotation
- Bounce handling and deliverability
- Quarantine workflow
- IMAP inbound sync
- Multi-node clustering
- Advanced mixnet routing
- Client SDK / mobile app
- Abuse operations console
- Compliance reporting
- SLA monitoring
- Geographic distribution

---

## 8. Quality Attributes

| Attribute | MVP Target | Mechanism |
|-----------|-----------|-----------|
| **Security** | Defense-in-depth | 5 security layers (TLS, sanitization, vault isolation, E2E encryption, transport anonymization) |
| **Privacy** | Metadata-minimal | 15-min bucketing, size padding, cover traffic, minimal audit |
| **Reliability** | Persist across restart | File-based storage, atomic writes, graceful drain |
| **Operability** | Single binary | Go stdlib only, env var config, 8.7MB binary |
| **Testability** | Race-safe | 32 tests passing with `-race`, interface-based DI |
| **Auditability** | Minimal but present | Audit events exist but contain no sensitive data |

---

## 9. Dependency Graph

```
model (0 deps) <-- foundation, imported by 15 packages
filestore (0 deps) <-- imported by vault, audit, relay, boundary
minlog (0 deps) <-- imported by intake, onion, vpn, main
transport (0 deps) <-- imported by delivery, vpn, main

auth --> model
config --> model
sanitizer --> model
metamin --> model
msgbus --> model
abuse (0 deps)

vault --> filestore, model
identity --> vault
contentenc (0 deps, stdlib crypto only)

audit --> filestore, model
relay --> filestore, model
boundary --> filestore, model
traffic --> model, relay
delivery --> transport, model

intake --> abuse, audit, contentenc, identity, metamin, minlog, model, msgbus, sanitizer
httpapi --> abuse, audit, auth, boundary, delivery, intake, model, relay, vault

onion --> minlog
vpn --> minlog, transport
bridge --> minlog, model

main --> all packages
```

**Key property:** No circular dependencies. `model` and foundation packages have zero internal dependencies. Pipeline packages depend only downward.

---

## 10. Configuration Reference

### Required (fatal on missing)

| Variable | Type | Description |
|----------|------|-------------|
| `DATA_ENCRYPTION_KEY_B64` | base64(32 bytes) | AES-256 key for relay/audit data |
| `VAULT_ENCRYPTION_KEY_B64` | base64(32 bytes) | AES-256 key for identity vault |
| `DEV_API_TOKEN` | string | API authentication token |
| `TLS_CERT_FILE` | path | X.509 certificate |
| `TLS_KEY_FILE` | path | Private key |

### Optional with defaults

| Variable | Default | Description |
|----------|---------|-------------|
| `LISTEN_ADDR` | `:8090` | TLS listener |
| `ONION_LISTEN_ADDR` | (none) | .onion HTTP listener |
| `DATA_DIR` | `./data` | Storage directory |
| `DELIVERY_MODE` | `record-only` | `record-only` or `smtp` |
| `TRANSPORT_MODE` | `socks5` | `lab`, `proxy`, `socks5`, `tor`, `vpn`, `vpn+tor` (`direct` is fail-closed banned per ADR-005) |
| `RELAY_MIN_DELAY_SECONDS` | `30` | Min random delay |
| `RELAY_MAX_DELAY_SECONDS` | `300` | Max random delay |
| `BATCH_INTERVAL_SECONDS` | `60` | Drain interval |
| `RATE_LIMIT_PER_MINUTE` | `10` | Per-actor limit |
| `AUDIT_RETENTION_HOURS` | `72` | Audit TTL |
| `RELAY_RETENTION_HOURS` | `24` | Queue TTL |
| `VAULT_RETENTION_HOURS` | `0` | Vault TTL (0=forever) |
| `SECRETS_FILE` | (none) | Path to secrets file |
| `TOR_ENABLED` | `false` | Enable Tor manager |
| `TOR_SOCKS_PORT` | `9050` | Tor SOCKS5 port |
| `VPN_ENABLED` | `false` | Enable WireGuard |

---

## 11. Verification

### Automated Tests (32 tests, 8 packages)

| Package | Tests | Coverage Focus |
|---------|-------|----------------|
| `contentenc` | 4 | Seal/Open, different ciphertexts, wrong key rejection, invalid key |
| `sanitizer` | 4 | Clean pass, script blocking, HTML stripping, header sanitization |
| `metamin` | 4 | Timestamp bucketing, pad/unpad roundtrip, size class selection, same-class indistinguishability |
| `minlog` | 5 | IP redaction, email redaction, sensitive key redaction, safe value passthrough, IPv6 |
| `vault` | 5 | Register/Resolve, revoke, list hides encrypted ref, persistence, vault file is encrypted |
| `abuse` | 3 | Within limit, over limit, actor isolation |
| `httpapi` | 11 | Healthz, unauthorized, submit success, blocked content, invalid recipient, rate limiting, audit after submit, security headers, CORS rejection, onion context, exit channels |
| `transport` | 7 | BuildChain modes, error cases, chain description |

### Smoke Test (7 checks)

1. Health check (`/healthz`)
2. Submit envelope (verify `envelope_id` and `status=sealed`)
3. Relay status (verify `pending_envelopes`)
4. Audit trail (verify `intake_accepted` event exists)
5. Audit minimality (verify NO content/IP/email in audit JSON)
6. Identity listing (verify endpoint works)
7. Auth enforcement (verify 401 without token)

### Live Verification (smoke-test.sh)

Builds binary, generates TLS cert, starts server, runs 7 assertions, stops server. All passed on 2026-04-03.

---

## 12. Risks and Mitigations

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Tor binary not available | Medium | Tor features disabled | Graceful degradation; `direct` mode works without Tor |
| WireGuard requires root | Medium | VPN features need sudo | Document requirement; systemd unit runs as non-root for non-VPN |
| File storage doesn't scale | Low (MVP) | Slow with thousands of envelopes | Post-MVP: database backend |
| Single-node bottleneck | Low (MVP) | No HA | Post-MVP: clustering |
| Statistical timing analysis | Medium | Identity correlation over time | Cover traffic + jitter help; honest about limitation |
| Operator key compromise | Low | Full de-anonymization | Key rotation support ready; HSM/KMS post-MVP |
| Go TLS fingerprint | Medium | Traffic identifiable as Go | Mitigated inside Tor circuit; consider utls for non-Tor |

---

## 13. Decision Log

| # | Decision | Rationale | Alternative Rejected |
|---|----------|-----------|---------------------|
| D1 | Standalone service, not privacy-gateway extension | Separation of concerns, different trust model | Extend privacy-gateway |
| D2 | Go stdlib only | No supply chain risk, single binary | External crypto libs |
| D3 | Two separate encryption keys | Vault compromise doesn't expose content (and vice versa) | Single key for everything |
| D4 | HKDF-SHA256 (not raw SHA-256) | Context binding prevents key confusion | Raw SHA-256 |
| D5 | In-process message bus | Zero network attack surface | External broker (Redis, NATS) |
| D6 | SOCKS5 from scratch | 80-line stdlib implementation, no supply chain | golang.org/x/net/proxy |
| D7 | Constant-time token comparison | Prevents timing oracle | Map lookup |
| D8 | 15-minute timestamp bucketing | Precision reduction without losing operational value | No timestamps / full precision |
| D9 | 4 size classes (not continuous) | Simple, fixed set ensures indistinguishability | Variable padding |
| D10 | Fisher-Yates with crypto/rand | Unbiased shuffle, no predictable ordering | math/rand shuffle |
| D11 | Context-based intake channel | Transport-level channel detection, not spoofable Host header | Host header parsing |
| D12 | File-based storage for MVP | No external dependencies | PostgreSQL/SQLite |
| D13 | Bridge to privacy-gateway | Optional integration, not required | Tight coupling |
