#!/bin/bash
# Anti-Trace Relay: WireGuard Server Setup
# Run on the VPS that will serve as the WireGuard endpoint
#
# Usage:
#   torsocks ssh root@<vps-ip>
#   bash provision-wireguard.sh
#
# This creates a WireGuard server and generates a peer config
# for the anti-trace-relay to connect through.

set -euo pipefail

WG_DIR="/etc/wireguard"
WG_INTERFACE="wg0"
WG_PORT=51820
WG_NETWORK="10.66.66"
WG_SERVER_IP="$WG_NETWORK.1/24"
WG_CLIENT_IP="$WG_NETWORK.2/32"

echo "=== WireGuard Server Setup ==="
echo ""

# Install if needed
if ! command -v wg &>/dev/null; then
  echo "Installing WireGuard..."
  apt-get update -qq && apt-get install -y -qq wireguard wireguard-tools
fi

# Enable IP forwarding
echo "Enabling IP forwarding..."
sysctl -w net.ipv4.ip_forward=1
if ! grep -q "net.ipv4.ip_forward=1" /etc/sysctl.conf; then
  echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf
fi

# Generate server keys
echo "Generating server keys..."
SERVER_PRIVATE=$(wg genkey)
SERVER_PUBLIC=$(echo "$SERVER_PRIVATE" | wg pubkey)

# Generate client (relay) keys
echo "Generating relay client keys..."
CLIENT_PRIVATE=$(wg genkey)
CLIENT_PUBLIC=$(echo "$CLIENT_PRIVATE" | wg pubkey)

# Generate preshared key (post-quantum resistance)
PSK=$(wg genpsk)

# Detect default network interface
DEFAULT_IF=$(ip route show default | awk '{print $5}' | head -1)
if [ -z "$DEFAULT_IF" ]; then
  DEFAULT_IF="eth0"
fi

# Write server config
cat > "$WG_DIR/$WG_INTERFACE.conf" <<EOF
# Anti-Trace Relay WireGuard Server
# Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)

[Interface]
PrivateKey = $SERVER_PRIVATE
Address = $WG_SERVER_IP
ListenPort = $WG_PORT
PostUp = iptables -A FORWARD -i $WG_INTERFACE -j ACCEPT; iptables -t nat -A POSTROUTING -o $DEFAULT_IF -j MASQUERADE
PostDown = iptables -D FORWARD -i $WG_INTERFACE -j ACCEPT; iptables -t nat -D POSTROUTING -o $DEFAULT_IF -j MASQUERADE

[Peer]
# Anti-Trace Relay Client
PublicKey = $CLIENT_PUBLIC
PresharedKey = $PSK
AllowedIPs = $WG_CLIENT_IP
EOF

chmod 600 "$WG_DIR/$WG_INTERFACE.conf"

# Start WireGuard
echo "Starting WireGuard..."
systemctl enable wg-quick@$WG_INTERFACE
systemctl start wg-quick@$WG_INTERFACE

# Get server public IP
SERVER_IP=$(curl -s --connect-timeout 5 ifconfig.me 2>/dev/null || echo "<YOUR-SERVER-IP>")

echo ""
echo "=== WireGuard Server Running ==="
echo ""
echo "Server public key: $SERVER_PUBLIC"
echo "Server endpoint:   $SERVER_IP:$WG_PORT"
echo "Server interface:  $WG_SERVER_IP"
echo ""
echo "=== Relay Client Configuration ==="
echo ""
echo "Set these env vars on the anti-trace-relay:"
echo ""
echo "  VPN_ENABLED=true"
echo "  VPN_PEER_PUBLIC_KEY=$SERVER_PUBLIC"
echo "  VPN_PEER_ENDPOINT=$SERVER_IP:$WG_PORT"
echo "  VPN_ADDRESS=$WG_CLIENT_IP"
echo "  VPN_PRESHARED_KEY=$PSK"
echo "  VPN_ALLOWED_IPS=0.0.0.0/0, ::/0"
echo "  VPN_DNS=$WG_NETWORK.1"
echo ""
echo "Or add to the relay's env file:"
echo ""
cat <<CLIENTENV
# --- Paste into /opt/anti-trace-relay/env ---
VPN_ENABLED=true
VPN_PRIVATE_KEY=$CLIENT_PRIVATE
VPN_PEER_PUBLIC_KEY=$SERVER_PUBLIC
VPN_PEER_ENDPOINT=$SERVER_IP:$WG_PORT
VPN_ADDRESS=$WG_CLIENT_IP
VPN_PRESHARED_KEY=$PSK
VPN_ALLOWED_IPS=0.0.0.0/0, ::/0
VPN_DNS=$WG_NETWORK.1
TRANSPORT_MODE=vpn+tor
CLIENTENV

echo ""
echo "=== Security Notes ==="
echo "- Server private key stored in $WG_DIR/$WG_INTERFACE.conf"
echo "- Client private key shown above ONCE -- save it securely"
echo "- PSK provides post-quantum resistance"
echo "- IP forwarding enabled for NAT"
echo "- Firewall: allow UDP $WG_PORT in UFW"
