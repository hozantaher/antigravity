#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)"

RC_SNAPSHOT_PATH="${RC_SNAPSHOT_PATH:-${ROOT_DIR}/RC-CHECKLIST-SNAPSHOT.md}"
RC_MEMO_PATH="${RC_MEMO_PATH:-${ROOT_DIR}/RC-DECISION-MEMO.md}"
CURRENT_STATUS_PATH="${CURRENT_STATUS_PATH:-${ROOT_DIR}/CURRENT-STATUS.md}"
RELEASE_TRACK_PATH="${RELEASE_TRACK_PATH:-${ROOT_DIR}/RELEASE-TRACK-MEMO.md}"

extract_backtick_value() {
  pattern="$1"
  file="$2"
  sed -n "s/${pattern}/\\1/p" "${file}" | head -n 1
}

for file in "${RC_SNAPSHOT_PATH}" "${RC_MEMO_PATH}" "${CURRENT_STATUS_PATH}" "${RELEASE_TRACK_PATH}"; do
  if [ ! -f "${file}" ]; then
    echo "FAIL: required file not found: ${file}"
    exit 1
  fi
done

snapshot_decision="$(extract_backtick_value '^- decision: `\([^`]*\)`$' "${RC_SNAPSHOT_PATH}")"
memo_decision="$(extract_backtick_value '^Current decision: `\([^`]*\)`$' "${RC_MEMO_PATH}")"
status_decision="$(extract_backtick_value '^- release candidate: `\([^`]*\)`$' "${CURRENT_STATUS_PATH}")"
release_track_decision="$(extract_backtick_value '^- first RC decision: `\([^`]*\)`$' "${RELEASE_TRACK_PATH}")"
sprint6_status="$(extract_backtick_value '^- `Sprint 6`: `\([^`]*\)`,.*$' "${CURRENT_STATUS_PATH}")"

for value_name in snapshot_decision memo_decision status_decision release_track_decision sprint6_status; do
  value="$(eval "printf '%s' \"\${${value_name}}\"")"
  if [ -z "${value}" ]; then
    echo "FAIL: unable to parse ${value_name}"
    exit 1
  fi
done

echo "RC decisions:"
echo "- RC-CHECKLIST-SNAPSHOT: ${snapshot_decision}"
echo "- RC-DECISION-MEMO: ${memo_decision}"
echo "- CURRENT-STATUS: ${status_decision}"
echo "- RELEASE-TRACK-MEMO: ${release_track_decision}"
echo "Sprint 6 status: ${sprint6_status}"

if [ "${snapshot_decision}" != "${memo_decision}" ] || \
   [ "${snapshot_decision}" != "${status_decision}" ] || \
   [ "${snapshot_decision}" != "${release_track_decision}" ]; then
  echo "FAIL: RC decision mismatch across docs"
  exit 1
fi

if [ "${snapshot_decision}" = "GO" ] && [ "${sprint6_status}" != "DONE" ]; then
  echo "FAIL: Sprint 6 should be DONE when decision is GO"
  exit 1
fi

if [ "${snapshot_decision}" = "NO-GO" ] && [ "${sprint6_status}" = "DONE" ]; then
  echo "FAIL: Sprint 6 cannot be DONE while decision is NO-GO"
  exit 1
fi

echo "PASS: RC docs are consistent"
