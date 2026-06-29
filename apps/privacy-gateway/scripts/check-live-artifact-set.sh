#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)"
LAST_RUN_PATH="${ROOT_DIR}/artifacts/last-run-path.txt"

ARTIFACT_DIR="${1:-}"

if [ "${ARTIFACT_DIR}" = "--help" ] || [ "${ARTIFACT_DIR}" = "-h" ]; then
  cat <<'EOF'
Usage:
  ./scripts/check-live-artifact-set.sh [artifact-dir]

Checks required live verification artifacts for RC post-run updates.
Uses ./artifacts/last-run-path.txt when artifact-dir is omitted.
EOF
  exit 0
fi

if [ -z "${ARTIFACT_DIR}" ]; then
  if [ -f "${LAST_RUN_PATH}" ]; then
    ARTIFACT_DIR="$(cat "${LAST_RUN_PATH}")"
  else
    echo "FAIL: artifact directory is required when no last-run marker exists"
    exit 1
  fi
fi

if [ ! -d "${ARTIFACT_DIR}" ]; then
  echo "FAIL: artifact directory not found: ${ARTIFACT_DIR}"
  exit 1
fi

METADATA_FILE="${ARTIFACT_DIR}/metadata.txt"
if [ ! -f "${METADATA_FILE}" ]; then
  echo "FAIL: missing metadata.txt in ${ARTIFACT_DIR}"
  exit 1
fi

# shellcheck disable=SC1090
. "${METADATA_FILE}"

missing=0

require_file() {
  target="$1"
  if [ ! -s "${target}" ]; then
    echo "MISSING: ${target}"
    missing=1
  fi
}

require_file "${ARTIFACT_DIR}/live-verification-report.md"
require_file "${ARTIFACT_DIR}/metadata.txt"
require_file "${ARTIFACT_DIR}/healthz.json"
require_file "${ARTIFACT_DIR}/aliases.json"
require_file "${ARTIFACT_DIR}/submissions.json"
require_file "${ARTIFACT_DIR}/outbox.json"
require_file "${ARTIFACT_DIR}/inbox.json"
require_file "${ARTIFACT_DIR}/channels.json"
require_file "${ARTIFACT_DIR}/alias-timeline.json"
require_file "${ARTIFACT_DIR}/submission-timeline.json"

if [ -n "${SUBMISSION_ID:-}" ]; then
  require_file "${ARTIFACT_DIR}/submission.json"
fi

if [ -n "${INBOX_ID:-}" ]; then
  require_file "${ARTIFACT_DIR}/inbox-timeline.json"
fi

if [ "${INTAKE_EVIDENCE_COLLECTED:-false}" = "true" ]; then
  require_file "${ARTIFACT_DIR}/intake-dashboard.json"
  require_file "${ARTIFACT_DIR}/intake-queue.json"
  if [ -n "${SUBMISSION_ID:-}" ]; then
    require_file "${ARTIFACT_DIR}/intake-submission.json"
    require_file "${ARTIFACT_DIR}/intake-submission-timeline.json"
  fi
fi

if [ "${missing}" -ne 0 ]; then
  echo "FAIL: live artifact set is incomplete"
  exit 1
fi

echo "PASS: live artifact set is complete"
