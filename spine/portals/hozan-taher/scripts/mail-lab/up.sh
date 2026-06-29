#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
# ML1.6 — bring Mail Lab stack up.
# ════════════════════════════════════════════════════════════════════════
#
# Workflow:
#   1. docker compose up -d   (mail-lab-seznam + mail-lab-dns)
#   2. wait healthy            (poll, timeout 5 min)
#   3. start mail-lab-api      (Go binary, host process, port 8090)
#   4. seed.sh                 (idempotent demo data — operator + 5 prospects)
#
# Flags:
#   --no-seed     skip the seed step (useful for CI)
#   --no-api      skip starting mail-lab-api (advanced — operator runs it)
#   --teardown    full down.sh --clean before starting (fresh slate)
#
# Exit codes:
#   0   success
#   1   docker compose failed
#   2   bootstrap script error
#   124 wait-healthy timeout

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT/infra/docker/mail-lab.yml"
API_PORT=${PORT:-8090}
API_KEY=${LAB_API_KEY:-dev-only}
DO_SEED=1
DO_API=1
PRE_TEARDOWN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-seed)  DO_SEED=0; shift ;;
    --no-api)   DO_API=0; shift ;;
    --teardown) PRE_TEARDOWN=1; shift ;;
    -h|--help)
      sed -n '5,22p' "$0"; exit 0 ;;
    *) echo "unknown: $1" >&2; exit 2 ;;
  esac
done

if ! docker info >/dev/null 2>&1; then
  echo "ERROR: docker daemon not reachable" >&2
  exit 1
fi

# ── 0. Optional teardown for clean slate ───────────────────────────────
if [[ $PRE_TEARDOWN -eq 1 ]]; then
  echo "── Pre-teardown (clean slate)"
  bash "$ROOT/scripts/mail-lab/down.sh" --clean || true
fi

# ── 1a. Pre-seed config volumes with bootstrap postmaster accounts ────
# docker-mailserver requires ≥1 account before Dovecot will start. The
# entrypoint rewrites /tmp/docker-mailserver/postfix-accounts.cf as part
# of `setup email add`, so the file must live in a writable named volume
# (NOT a bind-mount — `sed -i` fails with "Device or resource busy" —
# and NOT a compose `configs:` mount — those are read-only).
#
# Strategy: one-shot alpine container per provider that copies the seed
# file into the named volume *before* the mailserver starts. Idempotent:
# skip if the file already exists.
seed_provider_config() {
  local provider="$1"
  local volume="mail-lab-${provider}-config"
  docker volume create "$volume" >/dev/null
  docker run --rm \
    -v "$volume:/cfg" \
    -v "$ROOT/infra/mail-lab/$provider:/seed:ro" \
    alpine:3.19 sh -c '
      if [ ! -f /cfg/postfix-accounts.cf ]; then
        cp /seed/postfix-accounts.cf /cfg/postfix-accounts.cf
        chmod 0644 /cfg/postfix-accounts.cf
        echo "  seeded postfix-accounts.cf into '"$volume"'"
      fi
    '
}

seed_provider_config seznam
seed_provider_config gmail
seed_provider_config outlook

# ── 1b. compose up -d ──────────────────────────────────────────────────
echo "── docker compose up -d"
docker compose -f "$COMPOSE_FILE" up -d 2>&1 | grep -vE '^time=' || true

# ── 2. Wait healthy ────────────────────────────────────────────────────
wait_healthy() {
  local svc="$1"
  local deadline=$(( $(date +%s) + 300 ))
  while :; do
    local s
    s=$(docker inspect --format='{{.State.Health.Status}}' "$svc" 2>/dev/null || echo missing)
    case "$s" in
      healthy) return 0 ;;
      unhealthy) echo "  $svc: unhealthy" >&2; return 1 ;;
    esac
    if [[ $(date +%s) -ge $deadline ]]; then
      echo "  $svc: wait-healthy timeout" >&2
      return 124
    fi
    sleep 3
  done
}

echo "── Waiting for healthy (mail-lab-seznam + mail-lab-dns)"
wait_healthy mail-lab-seznam || exit 124
wait_healthy mail-lab-gmail || exit 124
wait_healthy mail-lab-outlook || exit 124
wait_healthy mail-lab-dns || exit 124
echo "── stack healthy"

# ── 3. mail-lab-api (optional, ML1.5+ feature) ────────────────────────
# The API service is not required for basic ML1.6 bootstrap. If present,
# operators can use it for advanced features (profiles, chaos, etc.).
# For now, we skip it — seed.sh uses docker exec directly.
if [[ $DO_API -eq 1 ]]; then
  if [[ -d "$ROOT/features/platform/mail-lab-api" ]]; then
    if pgrep -f 'mail-lab-api/cmd/mail-lab-api' >/dev/null 2>&1 || \
       curl -fsS "http://127.0.0.1:${API_PORT}/healthz" >/dev/null 2>&1; then
      echo "── mail-lab-api already running on :${API_PORT}"
    else
      echo "── starting mail-lab-api on :${API_PORT} (optional)"
      LOG_DIR="$ROOT/.mail-lab-logs"
      mkdir -p "$LOG_DIR"
      cd "$ROOT/features/platform/mail-lab-api" && \
        PORT="$API_PORT" LAB_API_KEY="$API_KEY" \
        nohup go run ./cmd/mail-lab-api/ \
          > "$LOG_DIR/api.log" 2>&1 &
      cd "$ROOT"
      # Wait for healthz (5 second timeout, non-blocking for ML1.6)
      for i in 1 2 3 4 5; do
        if curl -fsS "http://127.0.0.1:${API_PORT}/healthz" >/dev/null 2>&1; then
          echo "── mail-lab-api ready"
          break
        fi
        sleep 1
      done
    fi
  fi
fi

# ── 4. Seed demo data ──────────────────────────────────────────────────
if [[ $DO_SEED -eq 1 ]]; then
  echo "── Seeding demo data"
  bash "$ROOT/scripts/mail-lab/seed.sh"
fi

# ── Summary ────────────────────────────────────────────────────────────
cat <<EOF

── Mail Lab is up ─────────────────────────────────────────────────────

  Provider   seznam.lab
  Container  mail-lab-seznam (mx 10.20.0.10)
  DNS        mail-lab-dns    (10.20.0.2)

  SMTP       localhost:25025  (plain, host-mapped)
  IMAP       localhost:25143
  Submission localhost:25587

  Admin API  http://localhost:${API_PORT}  (X-Lab-Api-Key: ${API_KEY})

  Demo creds (postmaster, lab-only):
    postmaster@seznam.lab / lab-demo-only

EOF

if [[ $DO_SEED -eq 1 ]]; then
  cat <<EOF
  Seeded:    operator@seznam.lab + prospect[1-5]@seznam.lab
             (passwords: lab-demo-only)
EOF
fi

cat <<EOF

  Tear down: bash scripts/mail-lab/down.sh
  Wipe:      bash scripts/mail-lab/down.sh --clean

──────────────────────────────────────────────────────────────────────
EOF
