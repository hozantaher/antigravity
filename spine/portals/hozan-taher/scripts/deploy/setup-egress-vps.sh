#!/bin/bash
# setup-egress-vps.sh — Bootstrap a kernel-WireGuard + Dante SOCKS5 egress on a fresh Ubuntu VPS.
#
# Provides the production egress path that bypasses the wireguard-go userspace
# WG bug observed 2026-05-01 (STARTTLS i/o timeout to Seznam/Gmail/Yahoo/etc).
# This script runs ON the VPS, not on operator's local machine.
#
# Usage (run as root on a fresh Ubuntu 22.04 LTS host):
#   curl -sL https://raw.githubusercontent.com/messingdev/hozan-taher/main/scripts/deploy/setup-egress-vps.sh > setup.sh
#   chmod +x setup.sh
#   sudo ./setup.sh \
#     --mullvad-config /path/to/mullvad-cz3.conf \
#     --socks-password '<generate-strong-random>' \
#     --railway-egress-cidr '<railway-ip-range-or-0.0.0.0/0>'
#
# After completion the VPS exposes SOCKS5 on port 1080. Update Railway
# anti-trace-relay env: SOCKS_PROXY_ADDR=<vps-public-ip>:1080,
# SOCKS_PROXY_USER=antitrace, SOCKS_PROXY_PASS=<strong-random>.
#
# Tested provider tiers (all $0 forever):
#   - Oracle Cloud Free Tier ARM Ampere A1 (4 vCPU, 24GB RAM, region eu-frankfurt-1)
#   - GCP Free Tier e2-micro (us-west1/europe-west, 1 vCPU, 1GB RAM)
#   - Hetzner CCX13 Falkenstein (€5.83/mo, 2 vCPU, 8GB RAM) — preferred for production
#
# Cross-ref:
#   - docs/decisions/ADR-011-egress-kernel-wg-strategy.md
#   - docs/initiatives/2026-05-01-egress-fix-rollout.md
#   - reports/brutal-2026-05-01/probe-matrix-post-wgsocks.md (empirical evidence)

set -euo pipefail

MULLVAD_CONFIG=""
SOCKS_PASSWORD=""
RAILWAY_CIDR="0.0.0.0/0"
SOCKS_USER="antitrace"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mullvad-config) MULLVAD_CONFIG="$2"; shift 2 ;;
    --socks-password) SOCKS_PASSWORD="$2"; shift 2 ;;
    --railway-egress-cidr) RAILWAY_CIDR="$2"; shift 2 ;;
    --socks-user) SOCKS_USER="$2"; shift 2 ;;
    -h|--help)
      grep -E '^#( |$)' "$0" | sed 's/^# \?//' | head -40
      exit 0 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [[ -z "$MULLVAD_CONFIG" || -z "$SOCKS_PASSWORD" ]]; then
  echo "ERROR: --mullvad-config and --socks-password are required"
  echo "Run with --help for usage"
  exit 1
fi

if [[ ! -f "$MULLVAD_CONFIG" ]]; then
  echo "ERROR: Mullvad config file not found: $MULLVAD_CONFIG"
  exit 1
fi

if [[ "$EUID" -ne 0 ]]; then
  echo "ERROR: must run as root"
  exit 1
fi

WG_NAME=$(basename "$MULLVAD_CONFIG" .conf)
echo "[1/8] System update + base packages"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  ufw wireguard-tools dante-server fail2ban curl

echo "[2/8] Firewall (UFW): allow SSH + SOCKS5 from Railway egress range only"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null
if [[ "$RAILWAY_CIDR" == "0.0.0.0/0" ]]; then
  echo "  WARNING: SOCKS5 open to 0.0.0.0/0 — relying on auth + fail2ban"
  ufw allow 1080/tcp >/dev/null
else
  ufw allow from "$RAILWAY_CIDR" to any port 1080 proto tcp >/dev/null
fi
ufw --force enable >/dev/null
systemctl enable --now fail2ban >/dev/null

echo "[3/8] Install Mullvad WireGuard config: $WG_NAME"
cp "$MULLVAD_CONFIG" "/etc/wireguard/${WG_NAME}.conf"
chmod 600 "/etc/wireguard/${WG_NAME}.conf"
systemctl enable --now "wg-quick@${WG_NAME}" >/dev/null

# Wait for handshake
echo "[4/8] Waiting for WG handshake..."
for i in {1..15}; do
  if wg show "$WG_NAME" | grep -q "latest handshake"; then
    echo "  WG handshake established"
    break
  fi
  sleep 2
done

if ! wg show "$WG_NAME" | grep -q "latest handshake"; then
  echo "ERROR: WG handshake didn't complete in 30s"
  wg show "$WG_NAME"
  exit 2
fi

echo "[5/8] Verify Mullvad exit"
RESULT=$(curl --interface "$WG_NAME" -sS -m 10 https://am.i.mullvad.net/json 2>&1)
if echo "$RESULT" | grep -q '"is_mullvad":[[:space:]]*true'; then
  COUNTRY=$(echo "$RESULT" | grep -oE '"country":[[:space:]]*"[^"]+' | cut -d'"' -f4)
  echo "  Mullvad confirmed, country=${COUNTRY}"
else
  echo "ERROR: not connected to Mullvad via $WG_NAME"
  echo "$RESULT"
  exit 3
fi

echo "[6/8] Configure Dante SOCKS5"
EXT_IFACE=$(ip route | awk '/default/ {print $5; exit}')
cat > /etc/danted.conf <<EOF
logoutput: syslog
internal: ${EXT_IFACE} port = 1080
external: ${WG_NAME}
clientmethod: none
socksmethod: username
user.privileged: root
user.unprivileged: nobody

client pass {
  from: ${RAILWAY_CIDR} to: 0.0.0.0/0
  log: connect disconnect error
}

socks pass {
  from: ${RAILWAY_CIDR} to: 0.0.0.0/0
  command: connect
  protocol: tcp
  log: connect disconnect error
}
EOF

# Create SOCKS5 user with password
if ! id "$SOCKS_USER" &>/dev/null; then
  useradd -r -s /usr/sbin/nologin "$SOCKS_USER"
fi
echo "${SOCKS_USER}:${SOCKS_PASSWORD}" | chpasswd

systemctl enable --now danted >/dev/null
sleep 2

echo "[7/8] Verify SOCKS5 reachability"
PUBLIC_IP=$(curl -sS -m 10 https://api.ipify.org/)
echo "  VPS public IP: ${PUBLIC_IP}"
echo "  Test SOCKS5: from local machine run:"
echo "    curl -x socks5://${SOCKS_USER}:${SOCKS_PASSWORD}@${PUBLIC_IP}:1080 https://am.i.mullvad.net/json"

echo "[8/8] STARTTLS smoke test (will validate cert paths through SOCKS5+WG)"
for host in seznam.cz gmail.com outlook.com; do
  RESULT=$(timeout 15 curl --silent --max-time 12 \
    -x "socks5://${SOCKS_USER}:${SOCKS_PASSWORD}@127.0.0.1:1080" \
    --connect-to "smtp.${host}:587:smtp.${host}:587" \
    -k "https://smtp.${host}:587" 2>&1 | head -c 80 || echo "(timeout)")
  echo "  smtp.${host}:587 reachable: ${RESULT:0:60}"
done

cat <<EOF

=================================================================
SETUP COMPLETE
=================================================================

VPS public IP:     ${PUBLIC_IP}
SOCKS5 endpoint:   ${PUBLIC_IP}:1080
SOCKS5 user:       ${SOCKS_USER}
SOCKS5 password:   ${SOCKS_PASSWORD}  (also stored in /root/.socks5-creds)
WG interface:      ${WG_NAME}
Mullvad country:   ${COUNTRY}

Next steps (operator):
1. Save the password to 1Password / SecOps store
2. Update Railway anti-trace-relay service env:
     SOCKS_PROXY_ADDR=${PUBLIC_IP}:1080
     SOCKS_PROXY_USER=${SOCKS_USER}
     SOCKS_PROXY_PASS=${SOCKS_PASSWORD}
     EGRESS_TRANSPORT=external_socks5
     TRANSPORT_MODE=socks5
3. Trigger Railway redeploy
4. Run /v1/probe against smtp.seznam.cz:587 — STARTTLS should succeed <5s
5. Re-run brutal anonymity test — expect 36/36 delivery

Maintenance:
- WG handshake monitoring: watch -n30 'wg show ${WG_NAME}'
- Dante connect log: tail -f /var/log/syslog | grep danted
- Mullvad endpoint rotation: edit /etc/wireguard/${WG_NAME}.conf, restart wg-quick@${WG_NAME}

Troubleshooting:
- If STARTTLS still hangs: check WG MTU (1420 default), try lower (1280)
- If Hetzner abuse flag: rotate to Vultr or OVH CZ
- If Mullvad blocked by recipient: rotate WG endpoint country
=================================================================
EOF

echo "${SOCKS_PASSWORD}" > /root/.socks5-creds
chmod 600 /root/.socks5-creds
