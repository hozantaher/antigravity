#!/bin/sh

set -eu

ENV_FILE="${1:-./.env.fastmail.local}"
ARTIFACT_DIR="${ARTIFACT_DIR:-./artifacts/live-verification-$(date -u +%Y%m%dT%H%M%SZ)}"
LISTEN_URL="${LISTEN_URL:-http://localhost:8080}"
STARTUP_TIMEOUT_SECONDS="${STARTUP_TIMEOUT_SECONDS:-20}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)"
LOG_PATH="${ARTIFACT_DIR}/service.log"
PID_PATH="${ARTIFACT_DIR}/service.pid"
LAST_RUN_PATH="${ROOT_DIR}/artifacts/last-run-path.txt"

if [ ! -f "${ENV_FILE}" ]; then
  echo "FAIL: env file not found: ${ENV_FILE}"
  exit 1
fi

mkdir -p "${ARTIFACT_DIR}"

echo "Running env preflight"
"${SCRIPT_DIR}/check-fastmail-env.sh" "${ENV_FILE}"

echo "Starting privacy gateway from ${ROOT_DIR}"
# shellcheck disable=SC1090
(
  cd "${ROOT_DIR}"
  set -a
  . "${ENV_FILE}"
  set +a
  export GOCACHE=/tmp/go-build-cache
  nohup go run ./cmd/privacy-gateway > "${LOG_PATH}" 2>&1 &
  echo $! > "${PID_PATH}"
)

PID="$(cat "${PID_PATH}")"
mkdir -p "${ROOT_DIR}/artifacts"
printf '%s\n' "${ARTIFACT_DIR}" > "${LAST_RUN_PATH}"
echo "INFO: service PID=${PID}"
echo "INFO: service log=${LOG_PATH}"
echo "INFO: last run path=${LAST_RUN_PATH}"

attempt=0
while [ "${attempt}" -lt "${STARTUP_TIMEOUT_SECONDS}" ]; do
  if curl -fsS "${LISTEN_URL}/healthz" >/dev/null 2>&1; then
    echo "PASS: service is healthy at ${LISTEN_URL}"
    echo "Artifacts: ${ARTIFACT_DIR}"
    echo "PID file: ${PID_PATH}"
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 1
done

echo "FAIL: service did not become healthy within ${STARTUP_TIMEOUT_SECONDS}s"
echo "Last log lines:"
tail -n 40 "${LOG_PATH}" || true
exit 1
