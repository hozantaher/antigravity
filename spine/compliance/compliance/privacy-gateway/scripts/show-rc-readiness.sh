#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)"
LAST_RUN_PATH="${ROOT_DIR}/artifacts/last-run-path.txt"

STRICT_MODE=false
ARTIFACT_DIR=""

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage:
  ./scripts/show-rc-readiness.sh [--strict] [artifact-dir]

Prints RC readiness snapshot from canonical docs and live artifact marker.

Options:
  --strict  Also run consistency/artifact checks and fail on mismatch.
EOF
  exit 0
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --strict)
      STRICT_MODE=true
      ;;
    --help|-h)
      echo "Use --help with no additional arguments."
      exit 1
      ;;
    *)
      if [ -z "${ARTIFACT_DIR}" ]; then
        ARTIFACT_DIR="$1"
      else
        echo "FAIL: unexpected extra argument: $1"
        exit 1
      fi
      ;;
  esac
  shift
done

extract_backtick_value() {
  pattern="$1"
  file="$2"
  sed -n "s/${pattern}/\\1/p" "${file}" | head -n 1
}

RC_SNAPSHOT_PATH="${ROOT_DIR}/RC-CHECKLIST-SNAPSHOT.md"
RC_MEMO_PATH="${ROOT_DIR}/RC-DECISION-MEMO.md"
CURRENT_STATUS_PATH="${ROOT_DIR}/CURRENT-STATUS.md"
RELEASE_TRACK_PATH="${ROOT_DIR}/RELEASE-TRACK-MEMO.md"

snapshot_decision="$(extract_backtick_value '^- decision: `\([^`]*\)`$' "${RC_SNAPSHOT_PATH}")"
memo_decision="$(extract_backtick_value '^Current decision: `\([^`]*\)`$' "${RC_MEMO_PATH}")"
status_decision="$(extract_backtick_value '^- release candidate: `\([^`]*\)`$' "${CURRENT_STATUS_PATH}")"
track_decision="$(extract_backtick_value '^- first RC decision: `\([^`]*\)`$' "${RELEASE_TRACK_PATH}")"
sprint6_status="$(extract_backtick_value '^- `Sprint 6`: `\([^`]*\)`,.*$' "${CURRENT_STATUS_PATH}")"
blockers_line="$(extract_backtick_value '^- remaining release blockers: `\([^`]*\)`$' "${RC_SNAPSHOT_PATH}")"

if [ -z "${ARTIFACT_DIR}" ] && [ -f "${LAST_RUN_PATH}" ]; then
  ARTIFACT_DIR="$(cat "${LAST_RUN_PATH}")"
fi

REPORT_PATH=""
SUMMARY_PATH=""
if [ -n "${ARTIFACT_DIR}" ]; then
  REPORT_PATH="${ARTIFACT_DIR}/live-verification-report.md"
  SUMMARY_PATH="${ARTIFACT_DIR}/rc-update-summary.md"
fi

echo "RC Readiness Snapshot"
echo "- RC-CHECKLIST-SNAPSHOT decision: ${snapshot_decision:-unknown}"
echo "- RC-DECISION-MEMO decision: ${memo_decision:-unknown}"
echo "- CURRENT-STATUS decision: ${status_decision:-unknown}"
echo "- RELEASE-TRACK-MEMO decision: ${track_decision:-unknown}"
echo "- Sprint 6 status: ${sprint6_status:-unknown}"
echo "- Remaining blockers (snapshot): ${blockers_line:-unknown}"
if [ -n "${ARTIFACT_DIR}" ]; then
  echo "- Artifact dir: ${ARTIFACT_DIR}"
  echo "- Live report exists: $( [ -f "${REPORT_PATH}" ] && printf 'yes' || printf 'no' )"
  echo "- RC summary exists: $( [ -f "${SUMMARY_PATH}" ] && printf 'yes' || printf 'no' )"
else
  echo "- Artifact dir: not found"
fi

if [ "${STRICT_MODE}" = true ]; then
  echo "Running strict checks..."
  "${SCRIPT_DIR}/check-rc-doc-consistency.sh"
  if [ -n "${ARTIFACT_DIR}" ]; then
    "${SCRIPT_DIR}/check-live-artifact-set.sh" "${ARTIFACT_DIR}"
  else
    echo "FAIL: strict mode requires artifact-dir argument or last-run marker"
    exit 1
  fi
  echo "PASS: strict readiness checks passed"
fi
