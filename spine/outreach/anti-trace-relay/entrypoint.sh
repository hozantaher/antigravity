#!/bin/sh
# Anti-trace-relay entrypoint.
#
# Two egress modes (mutually exclusive — pool wins when both set):
#
# (1) Single-endpoint Mullvad (legacy):
#     WIREPROXY_CONFIG = full ini with one [Peer] block.
#     Spawns one bridge on 127.0.0.1:1080.
#
# (2) Multi-endpoint Mullvad pool (per-envelope rotation):
#     WIREPROXY_POOL_CONFIG = JSON array of N peers
#     WIREPROXY_POOL_PRIVATE_KEY / WIREPROXY_POOL_ADDRESS / WIREPROXY_POOL_DNS
#     Spawns N bridges on 127.0.0.1:108${i} (i in 0..9).
#
# EGRESS_TRANSPORT controls which userspace WG-SOCKS bridge runs:
#   wgsocks    (default) — in-house binary at /usr/local/bin/wgsocks
#   wireproxy  legacy fallback — /usr/local/bin/wireproxy
#
# Required env:
#   TRANSPORT_MODE=socks5 (single endpoint) | wgpool (multi)
#   SOCKS_PROXY_ADDR=127.0.0.1:1080  (single endpoint mode only)
#
# IMPORTANT: keep TOR_ENABLED unset/false.
set -e

resolve_bridge_bin() {
    transport="${EGRESS_TRANSPORT:-wgsocks}"
    case "$transport" in
        wgsocks)
            bridge_bin=/usr/local/bin/wgsocks
            bridge_label="wgsocks"
            ;;
        wireproxy)
            bridge_bin=/usr/local/bin/wireproxy
            bridge_label="wireproxy (legacy)"
            ;;
        *)
            echo "[entrypoint] unknown EGRESS_TRANSPORT=$transport, falling back to wgsocks"
            bridge_bin=/usr/local/bin/wgsocks
            bridge_label="wgsocks"
            ;;
    esac
    if [ ! -x "$bridge_bin" ]; then
        echo "[entrypoint] ERROR: $bridge_bin not found or not executable; aborting"
        exit 1
    fi
}

start_bridge_single() {
    resolve_bridge_bin
    echo "[entrypoint] WIREPROXY_CONFIG present — starting $bridge_label"
    printf '%s\n' "$WIREPROXY_CONFIG" > /tmp/wireproxy.conf
    "$bridge_bin" -c /tmp/wireproxy.conf &
    BRIDGE_PID=$!
    echo "[entrypoint] $bridge_label started pid=$BRIDGE_PID"
    sleep 2
}

write_pool_config() {
    # $1 = idx, $2 = peer_pubkey, $3 = peer_host
    idx="$1"; peer_pubkey="$2"; peer_host="$3"
    bind_port=$((1080 + idx))
    if [ "$bind_port" -gt 1089 ]; then
        echo "[entrypoint] FATAL: pool size > 10 (bind port $bind_port out of 108x range)" >&2
        exit 1
    fi
    # Per-instance UDP source port (51820 + idx) so the N wgsocks instances
    # don't collide on UDP bind. PersistentKeepalive=5 keeps Railway's egress
    # NAT mapping fresh — empirically Railway drops idle WG flows.
    wg_listen=$((51820 + idx))
    cat > /tmp/wireproxy_${idx}.conf <<CFG
[Interface]
PrivateKey = ${WIREPROXY_POOL_PRIVATE_KEY}
Address = ${WIREPROXY_POOL_ADDRESS}
DNS = ${WIREPROXY_POOL_DNS:-10.64.0.1}
ListenPort = ${wg_listen}

[Peer]
PublicKey = ${peer_pubkey}
AllowedIPs = 0.0.0.0/0,::0/0
Endpoint = ${peer_host}
PersistentKeepalive = ${WIREPROXY_POOL_KEEPALIVE:-5}

[Socks5]
BindAddress = 127.0.0.1:${bind_port}
CFG
    "$bridge_bin" -c /tmp/wireproxy_${idx}.conf &
    pid=$!
    echo "[entrypoint] $bridge_label[${idx}] pid=$pid bind=127.0.0.1:${bind_port} peer=${peer_host}"
}

start_bridge_pool() {
    resolve_bridge_bin
    if [ -z "$WIREPROXY_POOL_PRIVATE_KEY" ] || [ -z "$WIREPROXY_POOL_ADDRESS" ]; then
        echo "[entrypoint] FATAL: WIREPROXY_POOL_CONFIG set but WIREPROXY_POOL_PRIVATE_KEY or WIREPROXY_POOL_ADDRESS missing" >&2
        exit 1
    fi
    echo "[entrypoint] WIREPROXY_POOL_CONFIG present — spawning $bridge_label pool"
    # Parse JSON without jq (busybox image). One object per array entry.
    idx=0
    echo "$WIREPROXY_POOL_CONFIG" \
        | tr -d '\n' \
        | sed 's/},/}\n/g' \
        | while IFS= read -r entry; do
            [ -z "$entry" ] && continue
            peer_pubkey=$(echo "$entry" | sed -n 's/.*"peer_pubkey"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
            peer_host=$(echo "$entry" | sed -n 's/.*"peer_host"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
            if [ -z "$peer_pubkey" ] || [ -z "$peer_host" ]; then
                echo "[entrypoint] WARN: skipping malformed pool entry: $entry" >&2
                continue
            fi
            write_pool_config "$idx" "$peer_pubkey" "$peer_host"
            idx=$((idx + 1))
        done
    sleep 3
}

if [ -n "$WIREPROXY_POOL_CONFIG" ]; then
    start_bridge_pool
elif [ -n "$WIREPROXY_CONFIG" ]; then
    start_bridge_single
else
    echo "[entrypoint] WIREPROXY_CONFIG / WIREPROXY_POOL_CONFIG unset — skipping userspace WG bridge"
fi

exec /app/anti-trace-relay
