#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)"

# Load local env file if present (for local development)
if [ -f "$(dirname "$0")/.env.fastmail.local" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$(dirname "$0")/.env.fastmail.local"
  set +a
fi

ENV_FILE="${ENV_FILE:-${1:-./.env.fastmail.local}}"
AUTO_STOP="${AUTO_STOP:-false}"
RUN_RC_POSTRUN="${RUN_RC_POSTRUN:-false}"
RC_POSTRUN_APPLY="${RC_POSTRUN_APPLY:-false}"

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage:
  ./scripts/fastmail-live-assist.sh [env_file]

Optional env vars:
  AUTO_STOP=true   Run postcheck and stop immediately after successful startup.
  RUN_RC_POSTRUN=true   Run RC post-run workflow after postcheck.
  RC_POSTRUN_APPLY=true Apply RC draft sync into canonical docs (requires RUN_RC_POSTRUN=true).
  ENV_FILE=...     Override env file path.
  ARTIFACT_DIR=... Reuse explicit artifact dir.
  LISTEN_URL=...   Override service URL for health check.

Default behavior:
  1) prepare/check env
  2) start service in background
  3) print operator next commands (SMTP/IMAP live checks)
  4) wait for ENTER
  5) run postcheck and stop service
  6) optional RC post-run workflow (dry-run by default)
EOF
  exit 0
fi

if [ ! -f "${ENV_FILE}" ]; then
  echo "FAIL: env file not found: ${ENV_FILE}"
  exit 1
fi

echo "STEP 1/4: preparing and checking env"
"${SCRIPT_DIR}/check-fastmail-env.sh" "${ENV_FILE}"

echo "STEP 2/4: starting service"
"${SCRIPT_DIR}/start-live-run.sh" "${ENV_FILE}"
ARTIFACT_DIR_USED="$(cat "${ROOT_DIR}/artifacts/last-run-path.txt" 2>/dev/null || printf '')"

cleanup() {
  echo "INFO: stopping service"
  "${SCRIPT_DIR}/stop-live-run.sh" || true
}

if [ "${AUTO_STOP}" = "true" ]; then
  echo "STEP 3/4: auto-stop mode enabled, skipping manual live actions"
else
  cat <<'EOF'
STEP 3/4: run the provider-backed live actions now (in a second terminal):
  - create alias
  - create + relay native submission
  - run inbox sync checks
Then return here and press ENTER to run postcheck + stop.
EOF
  printf 'Press ENTER when ready for postcheck and shutdown... '
  read -r _
fi

echo "STEP 4/4: postcheck and shutdown"
if ! ENV_FILE="${ENV_FILE}" "${SCRIPT_DIR}/run-live-postcheck.sh"; then
  echo "FAIL: postcheck failed"
  cleanup
  exit 1
fi

cleanup
echo "PASS: assisted live run finished"
if [ -n "${ARTIFACT_DIR_USED}" ]; then
  echo "Artifacts: ${ARTIFACT_DIR_USED}"
fi

if [ "${RUN_RC_POSTRUN}" = "true" ]; then
  if [ -z "${ARTIFACT_DIR_USED}" ]; then
    echo "FAIL: cannot run RC post-run workflow without artifact directory"
    exit 1
  fi
  if [ "${RC_POSTRUN_APPLY}" = "true" ]; then
    echo "INFO: running RC post-run workflow with --apply"
    "${SCRIPT_DIR}/run-rc-postrun-workflow.sh" --apply \
      "${ARTIFACT_DIR_USED}/live-verification-report.md" \
      "${ARTIFACT_DIR_USED}"
  else
    echo "INFO: running RC post-run workflow (dry-run)"
    "${SCRIPT_DIR}/run-rc-postrun-workflow.sh" \
      "${ARTIFACT_DIR_USED}/live-verification-report.md" \
      "${ARTIFACT_DIR_USED}"
  fi
fi
