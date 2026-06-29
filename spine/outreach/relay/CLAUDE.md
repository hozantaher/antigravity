# anti-trace-relay

> **MANDATORY READ before any code change here:** [`docs/subsystem-maps/anti-trace.md`](../../docs/subsystem-maps/anti-trace.md) — canonical 42-step anti-trace pipeline (this service implements layers T1-T8 + D1-D8). Cite its commit SHA in PR description.

## Stack
Go 1.25, stdlib only (no third-party dependencies), single binary, 1300+ tests across 38 packages

## Commands
- Test: `go test ./...`
- Build: `go build ./cmd/relay/`

## Rules
- Zero external imports — stdlib only; any new dependency requires an explicit ADR
- Do not add "anonymous" or "untraceable" claims to docs or comments — the honest framing is "privacy-hardened relay with metadata minimization"
- All encryption keys must come from env vars (`DATA_ENCRYPTION_KEY_B64`, `VAULT_ENCRYPTION_KEY_B64`); never hardcode or derive from constants

## Egress (Mullvad-only)

The only supported outbound path is **wgsocks → Mullvad WireGuard** (in-house userspace WG + SOCKS5 bridge built from wireguard-go's netstack). The previous `wireproxy v1.1.2` binary is retained behind a feature flag (`EGRESS_TRANSPORT=wireproxy`) but defaults are off — wireproxy hangs at 28s i/o timeout on STARTTLS for 9/10 SMTP hosts (Seznam, Gmail, Yahoo, Mailgun, SendGrid, Brevo, Fastmail, Zoho); only Outlook completes. Bug is in wireproxy's `connForward` (uses `io.Copy` without `CloseWrite` half-close propagation).

Other transports retired:

- Free rotating SOCKS5 pool (proxifly/geonode/proxyscrape) — Czech recipient SMTP servers reject mail from public free-proxy IPs regardless of geo. `BuildChain("proxy", ...)` returns `ErrFreePoolForbidden`.
- Tor exit egress — Tor exit IPs are widely flagged; Tor daemon also interferes with the WG handshake on Railway. Don't enable.

Required Railway env on `anti-trace-relay`:

```
TRANSPORT_MODE=socks5      # or legacy alias "tor" — both route via SOCKS_PROXY_ADDR
SOCKS_PROXY_ADDR=127.0.0.1:1080
WIREPROXY_CONFIG=<multi-line ini>   # ini format consumed unchanged by wgsocks
EGRESS_TRANSPORT=wgsocks   # (optional, default) — flip to "wireproxy" for legacy fallback
TOR_ENABLED=false          # MUST stay off; embedded Tor breaks WG handshake on Railway
```

`WIREPROXY_CONFIG` format (paste full multi-line value into Railway secret):

```
[Interface]
PrivateKey = <from Mullvad WG generator>
Address = <assigned 10.x.x.x/32>
DNS = 10.64.0.1

[Peer]
PublicKey = <Mullvad server pubkey>
AllowedIPs = 0.0.0.0/0,::0/0
Endpoint = <czechia-prg-server>.mullvad.net:51820

[Socks5]
BindAddress = 127.0.0.1:1080
```

`TRANSPORT_MODE=direct` — **forbidden**, leaks Railway egress IP. `BuildChain` returns `ErrDirectTransportForbidden`.

### Multi-endpoint Mullvad rotation (`TRANSPORT_MODE=wgpool`)

Per-envelope rotation across N Mullvad endpoints — fixes the "all 36 envelopes from one IP" diversity 0/N regression. Implementation in `services/relay/internal/transport/wgpool/`. The `wgpool_audit_test.go` ratchet keeps wgpool as the only production site that constructs SOCKS5Transport against `127.0.0.1:108x`.

Pool wiring on Railway:

```
TRANSPORT_MODE=wgpool
WIREPROXY_POOL_PRIVATE_KEY=<account-level WG private key>
WIREPROXY_POOL_ADDRESS=10.73.69.226/32
WIREPROXY_POOL_CONFIG=[
  {"label":"cz5","peer_pubkey":"<wg pub>","peer_host":"cz5-wireguard.mullvad.net:51820","country":"CZ"},
  {"label":"de4","peer_pubkey":"<wg pub>","peer_host":"de4-wireguard.mullvad.net:51820","country":"DE"},
  {"label":"at1","peer_pubkey":"<wg pub>","peer_host":"at1-wireguard.mullvad.net:51820","country":"AT"}
]
MAILBOX_ENDPOINT_AFFINITY=true   # optional: warmup-friendly per-mailbox sticky for first N picks
```

`entrypoint.sh` spawns one wgsocks (or legacy wireproxy) instance per entry on `127.0.0.1:108${i}`. `wgpool.Pool` rotates via `SHA256(envelope_id || mailbox_id) mod active_endpoints`. Failing endpoints (3 dial failures) quarantine for 5 minutes. Pool size capped at 10. Endpoint health is exposed at `GET /v1/proxy-pool` (mode=`wg-pool`) and `GET /v1/egress-debug` (`pool_size`, `active_endpoints`, `quarantined_endpoints`).

## IMAP Sent-Folder Append (Sprint D)

Post-send IMAP APPEND lives in `internal/delivery/sent_appender.go` (moved from orchestrator in AW7-9 to access wgsocks on relay host).

**Required headers (always emitted):**
- `Date`: RFC 1123Z format. Auto-generated if caller omits it.
- `Message-ID`: Unique ID per append, format `<append-{random-hex}@domain>`. Auto-generated if omitted.
- These are mandatory for provider acceptance and Sent-folder visibility (e.g., Seznam rejects appends without Date).

**Folder discovery optimization (FolderCache):**
- `FolderCache` caches per-mailbox Sent folder names to avoid repeated SELECT iterations.
- Thread-safe (sync.RWMutex). Initialized per relay instance.
- On cache miss, tries candidates in `SentFolderCandidates` order and updates cache.
- On folder rename (rare): next append will iterate candidates again and refresh cache.

**Audit ratchet:**
- `append_required_headers_audit_test.go` enforces Date + Message-ID presence across ≥20 scenarios.
- Baseline 0 violations — prevents regression to pre-Sprint-D bug where empty headers → zero Sent-folder visibility.

## Known delivery limit

Even with Mullvad CZ exit, Seznam (and other Czech recipient SMTP servers) reject mail from Mullvad IPs as anti-VPN reputation. The egress architecture is operationally complete; final-mile delivery to Czech webmail providers requires a non-VPN sending IP (own CZ VPS / transactional email service). Tracked in memory `project_seznam_proxy_geo_mismatch.md`.
