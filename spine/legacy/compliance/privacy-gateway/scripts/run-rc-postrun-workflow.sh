#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)"
LAST_RUN_PATH="${ROOT_DIR}/artifacts/last-run-path.txt"

APPLY_MODE="${APPLY_MODE:-false}"
REPORT_PATH=""
OUTPUT_DIR=""

usage() {
  cat <<'EOF'
Usage:
  ./scripts/run-rc-postrun-workflow.sh [--apply] [live-report-path] [output-dir]

Default behavior:
  1) check-live-artifact-set.sh
  2) prepare-rc-update-summary.sh
  3) prepare-rc-doc-sync-draft.sh
  4) check-rc-doc-consistency.sh against draft files
  5) apply-rc-doc-sync-draft.sh (dry-run)

Apply behavior:
  - pass --apply (or APPLY_MODE=true)
  - step 5 applies draft files to canonical docs with backups
  - step 6 validates RC doc consistency on canonical docs
EOF
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

if [ "${1:-}" = "--apply" ]; then
  APPLY_MODE="true"
  shift
fi

REPORT_PATH="${1:-}"
OUTPUT_DIR="${2:-}"

if [ -z "${REPORT_PATH}" ]; then
  if [ -f "${LAST_RUN_PATH}" ]; then
    REPORT_PATH="$(cat "${LAST_RUN_PATH}")/live-verification-report.md"
  else
    echo "FAIL: live report path is required when no last-run marker exists"
    usage
    exit 1
  fi
fi

if [ ! -f "${REPORT_PATH}" ]; then
  echo "FAIL: live report not found: ${REPORT_PATH}"
  exit 1
fi

if [ -z "${OUTPUT_DIR}" ]; then
  OUTPUT_DIR="$(dirname "${REPORT_PATH}")"
fi

mkdir -p "${OUTPUT_DIR}"

SUMMARY_PATH="${OUTPUT_DIR}/rc-update-summary.md"
ARTIFACT_DIR_FROM_REPORT="$(dirname "${REPORT_PATH}")"
RC_DRAFT_PATH="${OUTPUT_DIR}/rc-checklist-snapshot.next.md"
STATUS_DRAFT_PATH="${OUTPUT_DIR}/current-status.next.md"
MEMO_DRAFT_PATH="${OUTPUT_DIR}/rc-decision-memo.next.md"
TRACK_DRAFT_PATH="${OUTPUT_DIR}/release-track-memo.next.md"

echo "STEP 1/5: validate live artifact set"
"${SCRIPT_DIR}/check-live-artifact-set.sh" "${ARTIFACT_DIR_FROM_REPORT}"

echo "STEP 2/5: generate rc-update-summary.md"
"${SCRIPT_DIR}/prepare-rc-update-summary.sh" "${REPORT_PATH}" "${SUMMARY_PATH}"

echo "STEP 3/5: generate RC doc sync draft files"
"${SCRIPT_DIR}/prepare-rc-doc-sync-draft.sh" "${SUMMARY_PATH}" "${OUTPUT_DIR}"

echo "STEP 4/5: validate RC draft consistency"
RC_SNAPSHOT_PATH="${RC_DRAFT_PATH}" \
RC_MEMO_PATH="${MEMO_DRAFT_PATH}" \
CURRENT_STATUS_PATH="${STATUS_DRAFT_PATH}" \
RELEASE_TRACK_PATH="${TRACK_DRAFT_PATH}" \
"${SCRIPT_DIR}/check-rc-doc-consistency.sh"

if [ "${APPLY_MODE}" = "true" ]; then
  echo "STEP 5/6: apply workflow (${APPLY_MODE})"
  "${SCRIPT_DIR}/apply-rc-doc-sync-draft.sh" --apply "${OUTPUT_DIR}"
  echo "STEP 6/6: validate RC doc consistency"
  "${SCRIPT_DIR}/check-rc-doc-consistency.sh"
else
  echo "STEP 5/5: apply workflow (${APPLY_MODE})"
  "${SCRIPT_DIR}/apply-rc-doc-sync-draft.sh" "${OUTPUT_DIR}"
fi

echo "PASS: RC post-run workflow completed"
echo "RC readiness snapshot:"
"${SCRIPT_DIR}/show-rc-readiness.sh" "${ARTIFACT_DIR_FROM_REPORT}"
echo "Output dir: ${OUTPUT_DIR}"
echo "Summary: ${SUMMARY_PATH}"
