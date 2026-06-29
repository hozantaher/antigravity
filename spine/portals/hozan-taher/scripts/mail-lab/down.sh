#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
# ML1.6 — bring Mail Lab stack down (preserves volumes by default).
# ════════════════════════════════════════════════════════════════════════
#
#   bash scripts/mail-lab/down.sh           # graceful stop
#   bash scripts/mail-lab/down.sh --clean   # wipe volumes (irreversible)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT/infra/docker/mail-lab.yml"
CLEAN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --clean) CLEAN=1; shift ;;
    -h|--help)
      sed -n '5,9p' "$0"; exit 0 ;;
    *) echo "unknown: $1" >&2; exit 2 ;;
  esac
done

# Stop the host-side mail-lab-api process if we started it.
pkill -f 'mail-lab-api/cmd/mail-lab-api' 2>/dev/null || true

if [[ $CLEAN -eq 1 ]]; then
  echo "── docker compose down -v (volumes WIPED)"
  docker compose -f "$COMPOSE_FILE" down -v 2>&1 | grep -vE '^time=' || true
else
  echo "── docker compose down (volumes preserved)"
  docker compose -f "$COMPOSE_FILE" down 2>&1 | grep -vE '^time=' || true
fi
echo "── done"
