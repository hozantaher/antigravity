#!/bin/bash
# Anti-Trace Relay: VPS Bootstrap Script
# Run on a fresh Debian 12+ / Ubuntu 22.04+ VPS
#
# Usage (from Tails/Whonix):
#   torsocks ssh root@<vps-ip>
#   curl -sL <url>/provision-server.sh | bash
#
# What this does:
#   1. Installs Docker, Tor, WireGuard, ufw
#   2. Generates all encryption keys
#   3. Configures firewall (Tor + WireGuard + SSH only)
#   4. Creates self-signed TLS cert
#   5. Writes env files
#   6. Prints .onion address after Tor starts
#
# What this does NOT do:
#   - Automatic relay startup (you review config first)
#   - WireGuard server setup (see provision-wireguard.sh)
#   - DNS/domain configuration

set -euo pipefail

RELAY_DIR="/opt/anti-trace-relay"
DATA_DIR="$RELAY_DIR/data"
CERTS_DIR="$RELAY_DIR/certs"
SECRETS_FILE="$RELAY_DIR/secrets"
ENV_FILE="$RELAY_DIR/env"

echo "=== Anti-Trace Relay: Server Provisioning ==="
echo ""

# --- 1. System update ---
echo "[1/7] Updating system..."
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq curl gnupg lsb-release ufw

# --- 2. Install Docker ---
echo "[2/7] Installing Docker..."
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
fi

# Install docker compose plugin
if ! docker compose version &>/dev/null; then
  apt-get install -y -qq docker-compose-plugin 2>/dev/null || true
fi

# --- 3. Install Tor ---
echo "[3/7] Installing Tor..."
apt-get install -y -qq tor
systemctl enable tor

# Configure Tor hidden service
mkdir -p /var/lib/tor/anti-trace-relay
chown debian-tor:debian-tor /var/lib/tor/anti-trace-relay
chmod 700 /var/lib/tor/anti-trace-relay

if ! grep -q "anti-trace-relay" /etc/tor/torrc 2>/dev/null; then
  cat >> /etc/tor/torrc <<TORRC

# Anti-Trace Relay hidden service
HiddenServiceDir /var/lib/tor/anti-trace-relay/
HiddenServicePort 443 127.0.0.1:8090
HiddenServiceVersion 3
TORRC
fi

systemctl restart tor
sleep 3

# --- 4. Install WireGuard ---
echo "[4/7] Installing WireGuard..."
apt-get install -y -qq wireguard wireguard-tools

# --- 5. Firewall ---
echo "[5/7] Configuring firewall..."
ufw --force reset
ufw default deny incoming
ufw default deny outgoing

# Allow SSH (incoming, for management via Tor)
ufw allow in 22/tcp

# Allow WireGuard (incoming, for client connections)
ufw allow in 51820/udp

# Allow Tor outbound (bootstrapping and circuit building)
ufw allow out 9001/tcp
ufw allow out 9030/tcp
ufw allow out 443/tcp
ufw allow out 80/tcp

# Allow DNS over Tor (local resolver)
ufw allow out 53/udp
ufw allow out 53/tcp

# Allow loopback
ufw allow in on lo
ufw allow out on lo

ufw --force enable

# --- 6. Generate keys and certs ---
echo "[6/7] Generating keys..."

mkdir -p "$RELAY_DIR" "$DATA_DIR" "$CERTS_DIR"
chmod 700 "$RELAY_DIR" "$DATA_DIR"

DATA_KEY=$(head -c 32 /dev/urandom | base64)
VAULT_KEY=$(head -c 32 /dev/urandom | base64)
API_TOKEN=$(head -c 24 /dev/urandom | base64)

# TLS certificate (self-signed, for .onion the cert is just formality)
openssl req -x509 -newkey rsa:4096 \
  -keyout "$CERTS_DIR/key.pem" \
  -out "$CERTS_DIR/cert.pem" \
  -days 365 -nodes \
  -subj "/CN=anti-trace-relay" 2>/dev/null
chmod 600 "$CERTS_DIR/key.pem"

# Write secrets file (chmod 600)
cat > "$SECRETS_FILE" <<EOF
DATA_ENCRYPTION_KEY_B64=$DATA_KEY
VAULT_ENCRYPTION_KEY_B64=$VAULT_KEY
DEV_API_TOKEN=$API_TOKEN
EOF
chmod 600 "$SECRETS_FILE"

# Write env file (non-secret config)
cat > "$ENV_FILE" <<EOF
LISTEN_ADDR=:8090
DATA_DIR=/app/data
DELIVERY_MODE=deaddrop
TRANSPORT_MODE=tor
TLS_CERT_FILE=/app/certs/cert.pem
TLS_KEY_FILE=/app/certs/key.pem
TOR_ENABLED=false
SOCKS_PROXY_ADDR=172.17.0.1:9050
EMISSION_INTERVAL_SECONDS=5
MIX_POOL_MIN_SIZE=20
DEV_USER_ID=operator
DEV_TENANT_ID=relay-tenant
RELAY_MIN_DELAY_SECONDS=30
RELAY_MAX_DELAY_SECONDS=300
BATCH_INTERVAL_SECONDS=60
RATE_LIMIT_PER_MINUTE=10
AUDIT_RETENTION_HOURS=72
RELAY_RETENTION_HOURS=24
EOF
chmod 644 "$ENV_FILE"

# --- 7. Print results ---
echo "[7/7] Done."
echo ""
echo "=== Provisioning Complete ==="
echo ""
echo "Relay directory: $RELAY_DIR"
echo "Data directory:  $DATA_DIR"
echo "Secrets file:    $SECRETS_FILE"
echo "Env file:        $ENV_FILE"
echo "TLS cert:        $CERTS_DIR/cert.pem"
echo ""

# Print .onion address
if [ -f /var/lib/tor/anti-trace-relay/hostname ]; then
  ONION=$(cat /var/lib/tor/anti-trace-relay/hostname)
  echo "Tor hidden service: $ONION"
  echo ""
  echo "Submitters can reach the relay at:"
  echo "  https://$ONION/v1/submit"
else
  echo "Tor hidden service: NOT YET AVAILABLE (may take 30-60s)"
  echo "  Check later: cat /var/lib/tor/anti-trace-relay/hostname"
fi

echo ""
echo "API token: $API_TOKEN"
echo "  (save this securely, it will not be shown again)"
echo ""
echo "=== Next Steps ==="
echo "1. Copy the anti-trace-relay Docker image to this server"
echo "2. Copy docker-compose.production.yml to $RELAY_DIR/"
echo "3. Run: cd $RELAY_DIR && docker compose -f docker-compose.production.yml up -d"
echo "4. Verify: curl -sk https://localhost:8090/healthz"
echo ""
echo "For WireGuard VPN setup: bash provision-wireguard.sh"
