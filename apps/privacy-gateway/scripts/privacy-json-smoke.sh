#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SNAPSHOT_DIR="/tmp/privacy-status-snapshots"

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage:
  ./scripts/privacy-json-smoke.sh [snapshot-dir]

Validates that privacy tooling JSON commands emit parseable JSON
and contain expected top-level keys.
EOF
  exit 0
fi

if [ -n "${1:-}" ]; then
  SNAPSHOT_DIR="$1"
fi

validate_json() {
  json_input="$1"
  printf '%s\n' "${json_input}" | python3 -c 'import json,sys; json.load(sys.stdin)'
}

assert_key() {
  json_input="$1"
  key="$2"
  if ! printf '%s\n' "${json_input}" | grep -q "\"${key}\""; then
    echo "FAIL: JSON missing key \"${key}\""
    exit 1
  fi
}

run_pass_json_check() {
  name="$1"
  key="$2"
  shift 2
  output="$("$@")"
  validate_json "${output}"
  assert_key "${output}" "${key}"
  echo "PASS: ${name}"
}

run_fail_json_check() {
  name="$1"
  key="$2"
  shift 2
  set +e
  output="$("$@" 2>/dev/null)"
  code=$?
  set -e
  if [ "${code}" -eq 0 ]; then
    echo "FAIL: ${name} expected non-zero exit"
    exit 1
  fi
  validate_json "${output}"
  assert_key "${output}" "${key}"
  echo "PASS: ${name} (expected fail path)"
}

run_report_file_json_check() {
  name="$1"
  key="$2"
  report_path="$3"
  shift 3
  output="$("$@")"
  if ! printf '%s\n' "${output}" | grep -q '^WROTE:'; then
    echo "FAIL: ${name} did not report output path"
    exit 1
  fi
  if [ ! -f "${report_path}" ]; then
    echo "FAIL: ${name} report file not found: ${report_path}"
    exit 1
  fi
  json_body="$(cat "${report_path}")"
  validate_json "${json_body}"
  assert_key "${json_body}" "${key}"
  echo "PASS: ${name}"
}

run_pass_json_check "privacy-next-step" "state" \
  "${SCRIPT_DIR}/privacy-next-step.sh" --json

run_pass_json_check "privacy-blockers" "status" \
  "${SCRIPT_DIR}/privacy-blockers.sh" --json

run_pass_json_check "privacy-status" "readiness" \
  "${SCRIPT_DIR}/privacy-status.sh" --skip-self-check --json

run_pass_json_check "privacy-capture-status" "json_path" \
  "${SCRIPT_DIR}/privacy-capture-status.sh" "${SNAPSHOT_DIR}" --skip-self-check --json

run_pass_json_check "privacy-prune-snapshots" "removed" \
  "${SCRIPT_DIR}/privacy-prune-snapshots.sh" "${SNAPSHOT_DIR}" --keep 20 --dry-run --json

run_pass_json_check "privacy-compare-snapshots" "changes" \
  "${SCRIPT_DIR}/privacy-compare-snapshots.sh" "${SNAPSHOT_DIR}" --json

run_pass_json_check "privacy-trend" "entries" \
  "${SCRIPT_DIR}/privacy-trend.sh" "${SNAPSHOT_DIR}" --limit 5 --json

run_pass_json_check "privacy-refresh" "comparison" \
  "${SCRIPT_DIR}/privacy-refresh.sh" "${SNAPSHOT_DIR}" --prune-keep 20 --prune-dry-run --json

run_pass_json_check "privacy-gate-pass" "result" \
  "${SCRIPT_DIR}/privacy-gate.sh" --require-state artifacts_ready --max-blockers 6 --json

run_fail_json_check "privacy-gate-fail" "failures" \
  "${SCRIPT_DIR}/privacy-gate.sh" --strict-gate --json

run_pass_json_check "privacy-refresh-gate-pass" "gate" \
  "${SCRIPT_DIR}/privacy-refresh-gate.sh" "${SNAPSHOT_DIR}" --prune-keep 20 --prune-dry-run --json

run_pass_json_check "privacy-refresh-gate-pass-result" "gate_exit_code" \
  "${SCRIPT_DIR}/privacy-refresh-gate.sh" "${SNAPSHOT_DIR}" --prune-keep 20 --prune-dry-run --json

run_fail_json_check "privacy-refresh-gate-fail" "gate" \
  "${SCRIPT_DIR}/privacy-refresh-gate.sh" "${SNAPSHOT_DIR}" --strict-gate --prune-keep 20 --prune-dry-run --json

run_fail_json_check "privacy-refresh-gate-fail-result" "gate_exit_code" \
  "${SCRIPT_DIR}/privacy-refresh-gate.sh" "${SNAPSHOT_DIR}" --strict-gate --prune-keep 20 --prune-dry-run --json

run_report_file_json_check "privacy-report-json" "status" "/tmp/privacy-status-report.json" \
  "${SCRIPT_DIR}/privacy-report.sh" /tmp/privacy-status-report.json --snapshot-dir "${SNAPSHOT_DIR}" --json

run_report_file_json_check "privacy-report-json-result" "gate_exit_code" "/tmp/privacy-status-report.json" \
  "${SCRIPT_DIR}/privacy-report.sh" /tmp/privacy-status-report.json --snapshot-dir "${SNAPSHOT_DIR}" --json

run_report_file_json_check "privacy-report-json-strict" "strict_gate" "/tmp/privacy-status-report.strict.json" \
  "${SCRIPT_DIR}/privacy-report.sh" /tmp/privacy-status-report.strict.json --snapshot-dir "${SNAPSHOT_DIR}" --strict-gate --json

run_report_file_json_check "privacy-report-json-strict-result" "result" "/tmp/privacy-status-report.strict.json" \
  "${SCRIPT_DIR}/privacy-report.sh" /tmp/privacy-status-report.strict.json --snapshot-dir "${SNAPSHOT_DIR}" --strict-gate --json

echo "PASS: privacy JSON smoke checks completed"
