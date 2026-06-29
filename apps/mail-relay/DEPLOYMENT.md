# Anti-Trace Relay: Deployment Guide

> **Provozuješ relay pro ohrožené osoby?**
> Přečti si nejdřív [OPSEC-DEPLOY.md](OPSEC-DEPLOY.md) -- anonymní software na ne-anonymní infrastruktuře je bezcenný. OPSEC guide popisuje anonymní VPS, platbu, přístup a ongoing bezpečnost.

## Prerequisites

- Go 1.25+
- TLS certificate and key (Let's Encrypt or self-signed for testing)
- Two 32-byte encryption keys (one for data, one for vault)

### Optional

- **Tor** (for hidden service intake and outbound anonymization)
- **WireGuard** (for VPN-level network protection)
- Both can be combined: VPN -> Tor -> exit (recommended for maximum privacy)

## Generate Encryption Keys

```bash
# Data encryption key (for relay queue, audit, exit channels)
export DATA_ENCRYPTION_KEY_B64=$(head -c 32 /dev/urandom | base64)

# Vault encryption key (for identity mappings -- SEPARATE from data key)
export VAULT_ENCRYPTION_KEY_B64=$(head -c 32 /dev/urandom | base64)

# API authentication token
export DEV_API_TOKEN=$(head -c 24 /dev/urandom | base64)
```

## Build

```bash
cd services/anti-trace-relay
go build -o anti-trace-relay ./cmd/anti-trace-relay/
```

---

## Mode 1: Record-Only (Development / Testing)

No outbound delivery, no Tor, no VPN. Safe for local testing.

```bash
# Generate self-signed TLS cert for testing
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -keyout key.pem -out cert.pem -days 365 -nodes \
  -subj "/CN=localhost"

export LISTEN_ADDR=:8090
export DATA_DIR=./data
export DELIVERY_MODE=record-only
# AT2.2 (ADR-005): TRANSPORT_MODE=direct is forbidden (boot fail-closed,
# exit code 48). Use `lab` for record-only; switch to socks5/vpn/vpn+tor
# in production.
export TRANSPORT_MODE=lab
export TLS_CERT_FILE=cert.pem
export TLS_KEY_FILE=key.pem
export DATA_ENCRYPTION_KEY_B64=$(head -c 32 /dev/urandom | base64)
export VAULT_ENCRYPTION_KEY_B64=$(head -c 32 /dev/urandom | base64)
export DEV_API_TOKEN=test-token-change-me
export DEV_USER_ID=user-dev
export DEV_TENANT_ID=tenant-dev

./anti-trace-relay
```

Test:
```bash
curl -k -X POST https://localhost:8090/v1/submit \
  -H "Authorization: Bearer test-token-change-me" \
  -H "Content-Type: application/json" \
  -d '{"recipient":"someone@example.com","subject":"Test","body":"Hello"}'
```

---

## Mode 2: Tor Hidden Service (Recommended)

Provides .onion intake address and routes outbound through Tor.

### Install Tor

```bash
# macOS
brew install tor

# Debian/Ubuntu
sudo apt install tor

# Verify
tor --version
```

### Configure

```bash
export LISTEN_ADDR=:8090
export ONION_LISTEN_ADDR=127.0.0.1:8091
export DATA_DIR=./data
export DELIVERY_MODE=record-only
export TRANSPORT_MODE=tor
export TLS_CERT_FILE=cert.pem
export TLS_KEY_FILE=key.pem

# Tor settings
export TOR_ENABLED=true
export TOR_SOCKS_PORT=9050
export TOR_HIDDEN_PORT=80
export TOR_BINARY=tor

# The service will:
# 1. Generate Ed25519 hidden service keys in $DATA_DIR/tor/hidden_service/
# 2. Create torrc automatically
# 3. Start Tor and wait for SOCKS5 to be ready
# 4. Log the .onion address at startup

export DATA_ENCRYPTION_KEY_B64=<your-data-key>
export VAULT_ENCRYPTION_KEY_B64=<your-vault-key>
export DEV_API_TOKEN=<your-secure-token>
export DEV_USER_ID=operator
export DEV_TENANT_ID=org-1

./anti-trace-relay
```

The .onion address will be printed at startup:
```
[INFO] anti-trace-relay: tor_hidden_service onion=<your-address>.onion
```

Submitters can reach the relay via:
- **Clearnet**: `https://<your-domain>:8090/v1/submit` (TLS)
- **Tor**: `http://<your-address>.onion/v1/submit` (Tor encryption, no TLS needed)

---

## Mode 3: WireGuard VPN

Routes all relay traffic through a WireGuard VPN tunnel.

### Setup VPN Server

On your VPN server, add a peer for the relay:

```ini
# /etc/wireguard/wg0.conf on the VPN SERVER
[Peer]
PublicKey = <relay-public-key>
AllowedIPs = 10.66.66.2/32
```

### Configure Relay

```bash
export LISTEN_ADDR=:8090
export DATA_DIR=./data
export DELIVERY_MODE=record-only
export TRANSPORT_MODE=vpn
export TLS_CERT_FILE=cert.pem
export TLS_KEY_FILE=key.pem

# VPN settings
export VPN_ENABLED=true
export VPN_PEER_PUBLIC_KEY=<server-public-key-base64>
export VPN_PEER_ENDPOINT=vpn.example.com:51820
export VPN_ADDRESS=10.66.66.2/32
export VPN_DNS=10.66.66.1
export VPN_ALLOWED_IPS="0.0.0.0/0, ::/0"
# VPN_PRIVATE_KEY is auto-generated if empty
# VPN_PRESHARED_KEY for post-quantum resistance (optional)

export DATA_ENCRYPTION_KEY_B64=<your-data-key>
export VAULT_ENCRYPTION_KEY_B64=<your-vault-key>
export DEV_API_TOKEN=<your-secure-token>
export DEV_USER_ID=operator
export DEV_TENANT_ID=org-1

# Requires root for WireGuard interface creation
sudo -E ./anti-trace-relay
```

---

## Mode 4: VPN + Tor (Maximum Privacy)

Defense in depth: VPN hides Tor usage from ISP, Tor hides destination from VPN.

```
[Relay] -> [WireGuard VPN] -> [Tor Entry] -> [Tor Circuit] -> [Tor Exit] -> [Destination]
```

- ISP sees: encrypted WireGuard traffic to VPN server
- VPN server sees: Tor traffic (but not destination)
- Tor exit sees: destination (but not relay's real IP)
- Destination sees: Tor exit node IP

### Configure

```bash
export TRANSPORT_MODE=vpn+tor

export TOR_ENABLED=true
export TOR_SOCKS_PORT=9050

export VPN_ENABLED=true
export VPN_PEER_PUBLIC_KEY=<server-public-key>
export VPN_PEER_ENDPOINT=vpn.example.com:51820
export VPN_ADDRESS=10.66.66.2/32

# All other settings same as above

sudo -E ./anti-trace-relay
```

---

## Transport Modes Summary

| Mode | ISP Sees | VPN Sees | Destination Sees | Requires |
|------|----------|----------|-----------------|----------|
| `direct` | Destination IP | N/A | Relay IP | Nothing |
| `tor` | Tor traffic | N/A | Tor exit IP | `tor` binary |
| `vpn` | VPN traffic | Destination IP | VPN IP | WireGuard, root |
| `vpn+tor` | VPN traffic | Tor traffic | Tor exit IP | Both, root |

---

## SMTP Delivery (Outbound)

When ready to deliver messages for real:

```bash
export DELIVERY_MODE=smtp
export SMTP_HOST=mail.example.com
export SMTP_PORT=587
export SMTP_USERNAME=relay@example.com
export SMTP_PASSWORD=<smtp-password>
export SMTP_HELLO_DOMAIN=relay.example.com
export SMTP_REQUIRE_STARTTLS=true
```

SMTP connections route through the configured transport chain (Tor/VPN).

---

## Security Checklist

- [ ] Both encryption keys set and backed up securely
- [ ] API token is cryptographically random (not guessable)
- [ ] TLS certificate is valid (not self-signed in production)
- [ ] `DATA_DIR` has `0700` permissions
- [ ] Tor hidden service keys backed up (losing them = new .onion address)
- [ ] Core dumps disabled (automatic at startup)
- [ ] No sensitive data in environment (consider secrets file)
- [ ] Log output reviewed -- no content or IPs should appear
- [ ] Rate limits configured for expected traffic volume
- [ ] Exit channels pre-registered and verified

## Files Created by Service

```
$DATA_DIR/
  vault-mappings.json    # Identity vault (encrypted with VAULT key)
  audit-events.json      # Audit trail (encrypted with DATA key)
  relay-queue.json       # Pending envelopes (encrypted with DATA key)
  exit-channels.json     # Registered exit channels (encrypted with DATA key)
  tor/                   # Tor state (when TOR_ENABLED=true)
    torrc                # Auto-generated
    hidden_service/
      hostname           # .onion address
      hs_ed25519_secret_key
      hs_ed25519_public_key
  vpn/                   # VPN state (when VPN_ENABLED=true)
    wg-atr0.conf         # WireGuard config (deleted on shutdown)
```
