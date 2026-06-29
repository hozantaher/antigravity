#!/usr/bin/env bash
# scripts/operator-practice/smoke.sh — one-command operator practice setup.
#
# Ties OP1.3 + OP2.x scripts into a single entry point. Boots lab if not
# already running, provisions operator mailbox, seeds N placeholder
# replies, prints dashboard URL. The user clicks one command and is
# ready to practice classification.
#
# Per OP1.4 + OP2.3 spec design — uses skip-pattern: any failed
# precondition prints diagnostic and exits non-zero; never silently
# pretends success.
#
# Usage:
#   bash scripts/operator-practice/smoke.sh
#   bash scripts/operator-practice/smoke.sh 25                       # custom count
#   bash scripts/operator-practice/smoke.sh 50 op@gmail.lab           # custom mailbox
#   COUNT=10 MAILBOX=op@seznam.lab bash scripts/operator-practice/smoke.sh
#
# Env knobs (all optional):
#   COUNT             default 10
#   MAILBOX           default op@gmail.lab
#   PASSWORD          default labpass
#   LAB_API           default http://localhost:8090
#   LAB_API_KEY       default dev-only
#   LAB_IMAP_HOST     default localhost
#   LAB_IMAP_PORT     default 25993
#   DASHBOARD_URL     default http://localhost:5175
#   SKIP_BOOT         non-empty: skip lab boot phase
#   SKIP_PROVISION    non-empty: skip mailbox provision phase
#
# Exit codes:
#   0  success
#   1  lab boot script not present
#   2  lab unhealthy after boot timeout
#   3  mailbox provision failed
#   4  seed-replies failed
#   5  fixtures missing

set -euo pipefail

# ── Args + env ────────────────────────────────────────────────────────

COUNT="${1:-${COUNT:-10}}"
MAILBOX="${2:-${MAILBOX:-op@gmail.lab}}"
PASSWORD="${PASSWORD:-labpass}"
LAB_API="${LAB_API:-http://localhost:8090}"
LAB_API_KEY="${LAB_API_KEY:-dev-only}"
LAB_IMAP_HOST="${LAB_IMAP_HOST:-localhost}"
LAB_IMAP_PORT="${LAB_IMAP_PORT:-25993}"
DASHBOARD_URL="${DASHBOARD_URL:-http://localhost:5175}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

log() { printf '\n[smoke] %s\n' "$*"; }
die() { printf '\n[smoke] ERROR: %s\n' "$*" >&2; exit "${2:-1}"; }

# ── Phase 0 — fixture sanity check ───────────────────────────────────

log "phase 0/4 — fixture sanity"
FIXTURE_DIR="${REPO_ROOT}/tests/fixtures/operator-replies/_placeholders"
PLACEHOLDER_COUNT="$(find "${FIXTURE_DIR}" -maxdepth 1 -type f -name '*.eml' 2>/dev/null | wc -l | tr -d ' ' || echo 0)"
if [[ "${PLACEHOLDER_COUNT}" -lt 1 ]]; then
  die "no placeholder fixtures in ${FIXTURE_DIR} (run from repo root, ensure tests/fixtures/operator-replies/_placeholders/ has .eml files)" 5
fi
log "  found ${PLACEHOLDER_COUNT} placeholder fixture(s)"

# ── Phase 1 — boot Mail Lab if not running ──────────────────────────

log "phase 1/4 — Mail Lab health"
if [[ -n "${SKIP_BOOT:-}" ]]; then
  log "  SKIP_BOOT set, skipping boot phase"
elif curl -sf --max-time 2 "${LAB_API}/healthz" >/dev/null 2>&1; then
  log "  ${LAB_API}/healthz already responsive — skipping boot"
else
  UP_SCRIPT="${REPO_ROOT}/scripts/mail-lab/up.sh"
  if [[ ! -x "${UP_SCRIPT}" ]]; then
    die "Mail Lab boot script not found at ${UP_SCRIPT} (mail-lab stack not in this checkout — see PR #220-#225)" 1
  fi
  log "  booting via ${UP_SCRIPT}…"
  bash "${UP_SCRIPT}" --providers=gmail || die "${UP_SCRIPT} failed" 1
  # Wait up to 60s for /healthz
  log "  waiting for ${LAB_API}/healthz (max 60s)…"
  for i in $(seq 1 30); do
    if curl -sf --max-time 2 "${LAB_API}/healthz" >/dev/null 2>&1; then
      log "  [${i}] healthy"
      break
    fi
    sleep 2
    if [[ ${i} -eq 30 ]]; then
      die "Mail Lab unhealthy after 60s — check 'docker compose -f infra/docker/mail-lab.yml logs --tail=200'" 2
    fi
  done
fi

# ── Phase 2 — provision operator mailbox if absent ─────────────────

log "phase 2/4 — operator mailbox"
if [[ -n "${SKIP_PROVISION:-}" ]]; then
  log "  SKIP_PROVISION set, skipping provision phase"
else
  STATUS="$(curl -s -o /dev/null -w '%{http_code}' \
    -H "X-Lab-Api-Key: ${LAB_API_KEY}" \
    "${LAB_API}/v1/mailbox/${MAILBOX}")"
  if [[ "${STATUS}" == "200" ]]; then
    log "  ${MAILBOX} exists"
  else
    log "  provisioning ${MAILBOX}…"
    curl -sf -X POST \
      -H "X-Lab-Api-Key: ${LAB_API_KEY}" \
      -H "Content-Type: application/json" \
      -d "{\"address\":\"${MAILBOX}\",\"password\":\"${PASSWORD}\"}" \
      "${LAB_API}/v1/mailbox" >/dev/null \
      || die "mailbox provision failed (HTTP $?). Run: curl -X POST -H 'X-Lab-Api-Key: ${LAB_API_KEY}' -H 'Content-Type: application/json' -d '{\"address\":\"${MAILBOX}\",\"password\":\"${PASSWORD}\"}' ${LAB_API}/v1/mailbox" 3
  fi
fi

# ── Phase 3 — seed N placeholder replies ───────────────────────────

log "phase 3/4 — seed ${COUNT} replies into ${MAILBOX}"
SEED="${REPO_ROOT}/scripts/operator-practice/seed-replies.mjs"
if [[ ! -x "${SEED}" ]]; then
  die "seed-replies.mjs not executable at ${SEED}" 4
fi
node "${SEED}" \
  --mailbox "${MAILBOX}" \
  --password "${PASSWORD}" \
  --count "${COUNT}" \
  --source placeholder \
  --host "${LAB_IMAP_HOST}" \
  --port "${LAB_IMAP_PORT}" \
  || die "seed-replies failed (exit $?)" 4

# ── Phase 4 — print next steps ──────────────────────────────────────

log "phase 4/4 — ready"
cat <<EOF

  ✓ Lab healthy at ${LAB_API}
  ✓ ${MAILBOX} exists with password ${PASSWORD}
  ✓ ${COUNT} placeholder reply/replies seeded into INBOX

Next:
  open ${DASHBOARD_URL}/replies
  → expect ${COUNT} new threads within 30s (orchestrator IMAP poll)
  → click thread → triage → classify

Reset (when done):
  bash ${REPO_ROOT}/scripts/mail-lab/clear-inbox.sh ${MAILBOX} \\
    --password ${PASSWORD} --confirm 'I-KNOW-THIS-WIPES-INBOX'

Time-accelerated replay (24h scenario in 60s):
  node ${REPO_ROOT}/scripts/operator-practice/arrival-curve.mjs \\
    --campaign-size 50 --duration-h 24 --output /tmp/curve.json
  bash ${REPO_ROOT}/scripts/mail-lab/replay-campaign.sh \\
    /tmp/curve.json ${MAILBOX} --password ${PASSWORD} --accel 1440

EOF
