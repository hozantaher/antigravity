# Anti-Trace Relay

Privacy-hardened communication relay for persecuted individuals in conflict zones. 30 packages, 116 tests, Go stdlib only, single binary.

**Honest positioning:** "Privacy-hardened relay with metadata minimization." Not "untraceable" or "anonymous."

## Quick Start

```bash
# Generate keys
export DATA_ENCRYPTION_KEY_B64=$(head -c 32 /dev/urandom | base64)
export VAULT_ENCRYPTION_KEY_B64=$(head -c 32 /dev/urandom | base64)
export DEV_API_TOKEN=$(head -c 16 /dev/urandom | base64)
export DEV_USER_ID=operator
export DEV_TENANT_ID=tenant-dev

# Generate TLS cert (testing only)
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem \
  -days 1 -nodes -subj "/CN=localhost"
export TLS_CERT_FILE=cert.pem TLS_KEY_FILE=key.pem

# Start relay
go run ./cmd/anti-trace-relay/

# Submit
curl -sk -X POST https://localhost:8090/v1/submit \
  -H "Authorization: Bearer $DEV_API_TOKEN" \
  -d '{"recipient":"target@example.com","subject":"Help","body":"I need assistance"}'
```

## Amnesic Client (zero state on device)

```bash
go build -ldflags "-s -w" -o submit ./cmd/submit/

echo "my secret passphrase" | ./submit \
  --relay https://relay.example.com \
  --recipient-key <64-char-hex-x25519-pubkey> \
  --message "Urgent: need evacuation"
```

Everything derived from passphrase. No files. Process exits in seconds.

## Defense Layers

### Against network surveillance (ADR-001)

| Layer | What it does |
|-------|-------------|
| Content sanitization | Strip HTML, scripts, tracking pixels, identifying headers |
| Identity vault | Separate AES key, opaque alias tokens, real identity never in pipeline |
| E2E encryption | X25519 + HKDF-SHA256 + AES-256-GCM, ephemeral keys |
| Metadata minimization | 15-minute timestamp buckets, 4 fixed size classes |
| Transport chain | SOCKS5/Tor/WireGuard VPN/VPN+Tor |

### Against state-level adversary (ADR-002)

| Layer | What it does |
|-------|-------------|
| Constant-rate emission | Fixed-interval output, zero volume signal |
| Pool mixing | crypto/rand uniform selection, 1/N correlation probability |
| Dead drops | HMAC-derived slots, hourly rotation, no sender-recipient link |
| Cover traffic | Indistinguishable from real at constant rate |

### Against physical device access (ADR-002)

| Layer | What it does |
|-------|-------------|
| Amnesic client | PBKDF2 600K + HKDF, zero persistent state |
| Secure memory | mlock, SecureBuffer, WipeAll registry, signal-safe cleanup |
| Duress system | Auth-failure = duress, forensically identical to wrong password |

## Delivery Modes

| Mode | Hierarchy | Description |
|------|-----------|-------------|
| `bridge` | **Primary MVP** | Forward to privacy-gateway intake endpoint ([ADR-004](ADR-004-primary-delivery-path.md)) |
| `smtp` | Secondary | Direct SMTP via anonymized transport (Tor/VPN) |
| `deaddrop` | Experimental | Constant-rate emission + pool mixing + dead drop slots |
| `record-only` | Local safety | Local testing, no outbound (default) |

## API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /healthz | No | Health check |
| POST | /v1/submit | Bearer | Submit message |
| GET | /v1/status | Bearer | Relay queue status |
| GET | /v1/audit-events | Bearer | Audit trail |
| GET/POST | /v1/exit-channels | Bearer | Exit channel management |
| GET | /v1/identities | Bearer | Identity mappings |
| POST | /v1/drop/{slotID} | No | Dead drop post |
| GET | /v1/drop/{slotID} | No | Dead drop poll |

## Configuration

### Required

| Variable | Description |
|----------|-------------|
| `DATA_ENCRYPTION_KEY_B64` | 32-byte AES key (base64) for relay data |
| `VAULT_ENCRYPTION_KEY_B64` | 32-byte AES key (base64) for identity vault |
| `DEV_API_TOKEN` | API authentication token |
| `TLS_CERT_FILE` | TLS certificate path |
| `TLS_KEY_FILE` | TLS private key path |

### Transport

| Variable | Default | Description |
|----------|---------|-------------|
| `TRANSPORT_MODE` | `socks5` | `lab`, `proxy`, `socks5`, `tor`, `vpn`, `vpn+tor` (`direct` is fail-closed banned per ADR-005) |
| `TOR_ENABLED` | `false` | Start managed Tor hidden service |
| `VPN_ENABLED` | `false` | Start WireGuard tunnel |
| `SOCKS_PROXY_ADDR` | | Tor SOCKS5 address (e.g. `127.0.0.1:9050`) |

### Delivery

| Variable | Default | Description |
|----------|---------|-------------|
| `DELIVERY_MODE` | `record-only` | `record-only`, `bridge`, `smtp`, `deaddrop` |
| `BRIDGE_GATEWAY_URL` | | Privacy-gateway URL for bridge mode |
| `EMISSION_INTERVAL_SECONDS` | `5` | Constant-rate interval (deaddrop mode) |
| `MIX_POOL_MIN_SIZE` | `20` | Anonymity set threshold |

See [DEPLOYMENT.md](DEPLOYMENT.md) for full configuration reference.

## Docker

```bash
docker build -t anti-trace-relay:0.1.0 .
docker run -v ./data:/app/data -v ./certs:/app/certs:ro \
  --env-file .env -p 8090:8090 anti-trace-relay:0.1.0
```

## Testing

```bash
go test ./... -race          # 116 tests, 22 packages
bash scripts/smoke-test.sh   # 7 live assertions
```

Verification status:

- `GOCACHE=/tmp/go-build-cache go test ./...` was verified locally during stabilization on `2026-04-04`
- `internal/httpapi` keeps socket-binding E2E coverage, but those tests are now opt-in via `HTTPAPI_SOCKET_E2E=1`
- default local test execution is stable in sandboxed environments because handler-level HTTP coverage remains in `server_test.go`

## Documentation

### Canonical SpecKit Surface

Use these as the active truth for the service:

- [README.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/README.md)
  - service identity, quick start, and canonical doc map
- [ADR.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/ADR.md)
  - MVP architecture and primary design decisions
- [ADR-004-primary-delivery-path.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/ADR-004-primary-delivery-path.md)
  - accepted decision for mode hierarchy and the primary near-term MVP path
- [ADR-005-verification-boundary.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/ADR-005-verification-boundary.md)
  - accepted decision for what counts as credible release-track verification
- [DEPLOYMENT.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/DEPLOYMENT.md)
  - deployment and runtime operations
- [CHANGELOG.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/CHANGELOG.md)
  - release history and verified milestone record

Interpretation rule:

- if a report, deployment note, or supporting guide disagrees with one of the files above, reconcile toward the canonical surface instead of creating another narrative document

### Reference Surface

These remain useful, but they are not the first source of current truth:

- [SPECKIT-DOC-MAP.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/SPECKIT-DOC-MAP.md)
- [CURRENT-STATUS.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/CURRENT-STATUS.md)
- [RELEASE-TRACK-MEMO.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/RELEASE-TRACK-MEMO.md)
- [DEVELOPMENT-PLAN.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/DEVELOPMENT-PLAN.md)
- [ADR-002.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/ADR-002.md)
- [ADR-003.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/ADR-003.md)
- [OPSEC-DEPLOY.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/OPSEC-DEPLOY.md)
- [SUBMITTER-GUIDE.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/SUBMITTER-GUIDE.md)
- [LIVE-DEPLOYMENT-REPORT.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/LIVE-DEPLOYMENT-REPORT.md)
- [CROSS-SERVICE-VERIFICATION-REPORT.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/CROSS-SERVICE-VERIFICATION-REPORT.md)

Use the reference surface for:

- development sequencing
- deeper threat-model context
- deployment hardening details
- submitter/operator guidance
- verification evidence

Do not treat it as the primary definition of current scope or runtime contract.

### Key Canonical Docs

| Document | Content |
|----------|---------|
| [ADR.md](ADR.md) | MVP Architecture (720 lines, 13 sections, 13 decisions) |
| [ADR-004-primary-delivery-path.md](ADR-004-primary-delivery-path.md) | Primary MVP path and mode hierarchy |
| [ADR-005-verification-boundary.md](ADR-005-verification-boundary.md) | Credible release-track verification boundary |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Deployment guide with 4 transport modes |
| [CHANGELOG.md](CHANGELOG.md) | Release history |
| [ADR-002.md](ADR-002.md) | Reference expansion for anti-state and anti-physical defenses |
| [CROSS-SERVICE-VERIFICATION-REPORT.md](CROSS-SERVICE-VERIFICATION-REPORT.md) | Reference verification evidence |

## Current Delivery Hierarchy

- `bridge` is the preferred near-term MVP delivery path
- `smtp` remains a supported secondary mode
- `deaddrop` remains strategically important, but higher-uncertainty
- `record-only` remains the local safety and testing mode

## Current Verification Hierarchy

- local tests and smoke runs establish engineering confidence
- cross-service `bridge -> privacy-gateway intake` verification is the primary near-term release gate
- live deaddrop verification is important supporting evidence, not the first release gate

Primary reference evidence for the current release hierarchy:

- [CROSS-SERVICE-VERIFICATION-REPORT.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/CROSS-SERVICE-VERIFICATION-REPORT.md) for the `bridge` path
- [LIVE-DEPLOYMENT-REPORT.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/LIVE-DEPLOYMENT-REPORT.md) as supporting evidence for `deaddrop`
- [RELEASE-TRACK-MEMO.md](/Users/messingtomas/Taher/hozan-taher/services/anti-trace-relay/RELEASE-TRACK-MEMO.md) for the current release-call summary

## Packages (30)

```
model config filestore minlog auth          # Foundation
sanitizer vault identity metamin contentenc # Core pipeline
msgbus relay traffic                        # Relay (ADR-001 legacy)
constrate pool deaddrop                     # Anti-state (ADR-002)
amnesic ephemeral duress                    # Anti-physical (ADR-002)
transport onion vpn                         # Network anonymization
intake httpapi delivery bridge              # Integration
abuse audit boundary                        # Policy and audit
```
