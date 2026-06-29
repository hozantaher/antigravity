#!/usr/bin/env bash
# scripts/mail-lab/chaos.sh — toxiproxy control surface (ML3.4).
#
# Adds/removes/lists "toxics" on the running mail-lab toxiproxy instance.
# The toxiproxy container is brought up by mail-lab-chaos.yml overlay;
# this script just talks to its admin API.
#
# Common scenarios:
#   chaos.sh add latency 500            # 500ms +/- 100ms on all SMTP+IMAP
#   chaos.sh add bandwidth 64           # 64 KB/s cap (slow upload sim)
#   chaos.sh add slow_close 2000        # delay FIN-ACK by 2s
#   chaos.sh add reset_peer 50          # 50% chance reset on read
#   chaos.sh list                       # show active toxics
#   chaos.sh clear                      # remove every toxic
#
# Targets:
#   --proxy <name>     limit to one upstream (default: all 4)
#   --direction <up|down>  upstream/downstream (default: downstream)
#
# Exit codes:
#   0 ok
#   1 toxiproxy not reachable
#   2 unknown toxic name
#   3 missing required argument

set -euo pipefail

TP=${TOXIPROXY:-http://localhost:28474}
PROXIES=("seznam-smtp" "seznam-smtps" "seznam-submission" "seznam-imaps")

log() { echo "[chaos] $*"; }
die() { log "ERROR: $*"; exit "${2:-1}"; }

check_toxiproxy() {
  if ! curl -sf "$TP/version" >/dev/null 2>&1; then
    die "toxiproxy not reachable at $TP — start mail-lab-chaos overlay first" 1
  fi
}

usage() {
  cat <<EOF
Usage: chaos.sh <command> [args]

Commands:
  add <toxic_name> <value>   Add toxic (latency|bandwidth|slow_close|reset_peer|timeout|slicer)
  remove <toxic_name>         Remove toxic by name
  list                        Show active toxics on every proxy
  clear                       Remove every toxic from every proxy
  status                      Compact health summary
  help                        This message

Toxic value semantics:
  latency       milliseconds (jitter = value/5)
  bandwidth     KB/s upload cap
  slow_close    milliseconds delay on connection close
  reset_peer    probability 0..100 (% chance per read)
  timeout       milliseconds before bytes are dropped
  slicer        average-byte slice size (jitter = value/4, microseconds delay)

Options:
  --proxy <name>     Limit to one of: ${PROXIES[*]}
  --direction <up|down>  upstream or downstream (default: downstream)
EOF
}

# Parse common flags before subcommand routing.
TARGET_PROXY=""
DIRECTION="downstream"
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --proxy) TARGET_PROXY="$2"; shift 2 ;;
    --direction) DIRECTION="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
set -- "${ARGS[@]:-}"

cmd="${1:-help}"
shift || true

case "$cmd" in
  add)
    [[ $# -ge 2 ]] || die "add requires <toxic_name> <value>" 3
    toxic="$1"; value="$2"
    case "$toxic" in
      latency)    payload="{\"type\":\"latency\",\"attributes\":{\"latency\":$value,\"jitter\":$((value/5))}}" ;;
      bandwidth)  payload="{\"type\":\"bandwidth\",\"attributes\":{\"rate\":$value}}" ;;
      slow_close) payload="{\"type\":\"slow_close\",\"attributes\":{\"delay\":$value}}" ;;
      reset_peer) payload="{\"type\":\"reset_peer\",\"attributes\":{\"timeout\":$value}}" ;;
      timeout)    payload="{\"type\":\"timeout\",\"attributes\":{\"timeout\":$value}}" ;;
      slicer)     payload="{\"type\":\"slicer\",\"attributes\":{\"average_size\":$value,\"size_variation\":$((value/4)),\"delay\":1000}}" ;;
      *) die "unknown toxic: $toxic" 2 ;;
    esac
    check_toxiproxy
    targets=("${PROXIES[@]}")
    [[ -n "$TARGET_PROXY" ]] && targets=("$TARGET_PROXY")
    for p in "${targets[@]}"; do
      log "adding $toxic=$value to $p ($DIRECTION)"
      body=$(echo "$payload" | sed "s/}}$/,\"name\":\"$toxic\",\"stream\":\"$DIRECTION\"}}/")
      curl -fsS -X POST -H 'Content-Type: application/json' \
        "$TP/proxies/$p/toxics" -d "$body" >/dev/null \
        || die "failed to add toxic to $p"
    done
    log "done"
    ;;

  remove)
    [[ $# -ge 1 ]] || die "remove requires <toxic_name>" 3
    toxic="$1"
    check_toxiproxy
    targets=("${PROXIES[@]}")
    [[ -n "$TARGET_PROXY" ]] && targets=("$TARGET_PROXY")
    for p in "${targets[@]}"; do
      log "removing $toxic from $p"
      curl -fsS -X DELETE "$TP/proxies/$p/toxics/$toxic" >/dev/null || true
    done
    log "done"
    ;;

  list)
    check_toxiproxy
    for p in "${PROXIES[@]}"; do
      echo "── $p ──"
      curl -fsS "$TP/proxies/$p/toxics" || echo "  (none)"
      echo
    done
    ;;

  clear)
    check_toxiproxy
    log "clearing all toxics on every proxy"
    for p in "${PROXIES[@]}"; do
      toxics=$(curl -fsS "$TP/proxies/$p/toxics" | tr -d ' \n' | grep -oE '"name":"[^"]+"' | sed 's/"name":"//;s/"//' || true)
      for t in $toxics; do
        curl -fsS -X DELETE "$TP/proxies/$p/toxics/$t" >/dev/null || true
        echo "  $p: removed $t"
      done
    done
    log "done"
    ;;

  status)
    check_toxiproxy
    log "toxiproxy at $TP"
    curl -fsS "$TP/proxies" | tr ',' '\n' | grep -E '"name"|"enabled"' || true
    ;;

  help|--help|-h|"")
    usage
    ;;

  *)
    die "unknown command: $cmd (run 'chaos.sh help')" 3
    ;;
esac
