#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)"
LAST_RUN_PATH="${ROOT_DIR}/artifacts/last-run-path.txt"
ENV_FILE="${ENV_FILE:-}"

if [ -z "${ENV_FILE}" ]; then
  DEFAULT_ENV_FILE="${ROOT_DIR}/.env.fastmail.local"
  if [ -f "${DEFAULT_ENV_FILE}" ]; then
    ENV_FILE="${DEFAULT_ENV_FILE}"
  fi
fi

if [ -n "${ENV_FILE}" ]; then
  if [ ! -f "${ENV_FILE}" ]; then
    echo "ERROR: ENV_FILE does not exist: ${ENV_FILE}" >&2
    exit 1
  fi
  set -a
  # shellcheck source=/dev/null
  . "${ENV_FILE}"
  set +a
  echo "INFO: loaded env from ${ENV_FILE}"
fi

BASE_URL="${BASE_URL:-http://localhost:8080}"
API_TOKEN="${API_TOKEN:-${DEV_API_TOKEN:-dev-token}}"
INTAKE_API_TOKEN="${INTAKE_API_TOKEN:-}"
ARTIFACT_DIR="${ARTIFACT_DIR:-}"
REPORT_PATH="${REPORT_PATH:-}"
ALIAS_ID="${ALIAS_ID:-}"
SUBMISSION_ID="${SUBMISSION_ID:-}"
INBOX_ID="${INBOX_ID:-}"
PROVIDER="${PROVIDER:-Fastmail}"
OPERATOR_NAME="${OPERATOR_NAME:-TBD}"
ENVIRONMENT_NAME="${ENVIRONMENT_NAME:-TBD}"
SERVICE_VERSION="${SERVICE_VERSION:-TBD}"

if [ -z "${ARTIFACT_DIR}" ]; then
  if [ -f "${LAST_RUN_PATH}" ]; then
    ARTIFACT_DIR="$(cat "${LAST_RUN_PATH}")"
    echo "INFO: using last run artifact dir ${ARTIFACT_DIR}"
  else
    ARTIFACT_DIR="./artifacts/live-verification-$(date -u +%Y%m%dT%H%M%SZ)"
    echo "INFO: no last run marker found, using ${ARTIFACT_DIR}"
  fi
fi

if [ -z "${REPORT_PATH}" ] || [ "${REPORT_PATH}" = "/live-verification-report.md" ]; then
  REPORT_PATH="${ARTIFACT_DIR}/live-verification-report.md"
fi

echo "Running read-model smoke verification"
BASE_URL="${BASE_URL}" \
API_TOKEN="${API_TOKEN}" \
INTAKE_API_TOKEN="${INTAKE_API_TOKEN}" \
ALIAS_ID="${ALIAS_ID}" \
SUBMISSION_ID="${SUBMISSION_ID}" \
INBOX_ID="${INBOX_ID}" \
"${SCRIPT_DIR}/verify-read-models.sh"

echo "Collecting live evidence"
BASE_URL="${BASE_URL}" \
API_TOKEN="${API_TOKEN}" \
OUTPUT_DIR="${ARTIFACT_DIR}" \
INTAKE_API_TOKEN="${INTAKE_API_TOKEN}" \
ALIAS_ID="${ALIAS_ID}" \
SUBMISSION_ID="${SUBMISSION_ID}" \
INBOX_ID="${INBOX_ID}" \
"${SCRIPT_DIR}/collect-live-evidence.sh"

echo "Bootstrapping report draft"
PROVIDER="${PROVIDER}" \
OPERATOR_NAME="${OPERATOR_NAME}" \
ENVIRONMENT_NAME="${ENVIRONMENT_NAME}" \
SERVICE_VERSION="${SERVICE_VERSION}" \
"${SCRIPT_DIR}/bootstrap-live-report.sh" \
  "${ARTIFACT_DIR}" \
  "${REPORT_PATH}"

echo "PASS: live postcheck completed"
echo "Artifacts: ${ARTIFACT_DIR}"
echo "Report: ${REPORT_PATH}"
