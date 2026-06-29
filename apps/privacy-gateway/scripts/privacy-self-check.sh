#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)"
FAST_MODE=false
JSON_MODE=false

usage() {
  cat <<'EOF'
Usage:
  ./scripts/privacy-self-check.sh [--fast] [--json]

Options:
  --fast  Skip extended expected-fail diagnostics for a quicker local check.
  --json  Emit machine-readable JSON output on success.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --fast)
      FAST_MODE=true
      ;;
    --json)
      JSON_MODE=true
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "FAIL: unsupported argument: $1"
      usage
      exit 1
      ;;
  esac
  shift
done

log() {
  if [ "${JSON_MODE}" = false ]; then
    echo "$1"
  fi
}

require_exec() {
  path="$1"
  if [ ! -x "${path}" ]; then
    echo "FAIL: missing executable: ${path}"
    exit 1
  fi
}

GATE_FAIL_JSON="$(mktemp /tmp/privacy-gate-expected-fail.XXXXXX)"
CI_FAIL_JSON="$(mktemp /tmp/privacy-ci-expected-fail.XXXXXX)"
CI_PASS_JSON="$(mktemp /tmp/privacy-ci-pass.XXXXXX)"
CI_REPORT_JSON="$(mktemp /tmp/privacy-status-report-ci-json.XXXXXX)"
CI_REPORT_MD="$(mktemp /tmp/privacy-status-report-ci-md.XXXXXX)"
REPORT_STRICT_JSON="$(mktemp /tmp/privacy-status-report-strict-json.XXXXXX)"

cleanup_temp_files() {
  rm -f "${GATE_FAIL_JSON}" "${CI_FAIL_JSON}" "${CI_PASS_JSON}" "${CI_REPORT_JSON}" "${CI_REPORT_MD}" "${REPORT_STRICT_JSON}"
}

trap cleanup_temp_files EXIT

log "STEP 1/4: verify root privacy wrappers exist"
require_exec "${SCRIPT_DIR}/_privacy-readiness-lib.sh"
require_exec "${SCRIPT_DIR}/privacy-help.sh"
require_exec "${SCRIPT_DIR}/privacy-json-smoke.sh"
require_exec "${SCRIPT_DIR}/privacy-ci.sh"
require_exec "${SCRIPT_DIR}/privacy-next-step.sh"
require_exec "${SCRIPT_DIR}/privacy-blockers.sh"
require_exec "${SCRIPT_DIR}/privacy-status.sh"
require_exec "${SCRIPT_DIR}/privacy-capture-status.sh"
require_exec "${SCRIPT_DIR}/privacy-prune-snapshots.sh"
require_exec "${SCRIPT_DIR}/privacy-compare-snapshots.sh"
require_exec "${SCRIPT_DIR}/privacy-trend.sh"
require_exec "${SCRIPT_DIR}/privacy-refresh.sh"
require_exec "${SCRIPT_DIR}/privacy-gate.sh"
require_exec "${SCRIPT_DIR}/privacy-refresh-gate.sh"
require_exec "${SCRIPT_DIR}/privacy-report.sh"
require_exec "${SCRIPT_DIR}/run-privacy-stability.sh"
require_exec "${SCRIPT_DIR}/show-privacy-rc-readiness.sh"
require_exec "${SCRIPT_DIR}/run-privacy-rc-postrun.sh"
require_exec "${SCRIPT_DIR}/prepare-privacy-fastmail-env.sh"
require_exec "${SCRIPT_DIR}/run-privacy-fastmail-assist.sh"

log "STEP 2/4: verify service scripts exist"
require_exec "${ROOT_DIR}/services/privacy-gateway/scripts/run-local-stability-check.sh"
require_exec "${ROOT_DIR}/services/privacy-gateway/scripts/show-rc-readiness.sh"
require_exec "${ROOT_DIR}/services/privacy-gateway/scripts/run-rc-postrun-workflow.sh"
require_exec "${ROOT_DIR}/services/privacy-gateway/scripts/prepare-fastmail-env.sh"
require_exec "${ROOT_DIR}/services/privacy-gateway/scripts/fastmail-live-assist.sh"

log "STEP 3/4: smoke help/readiness commands"
"${SCRIPT_DIR}/privacy-help.sh" >/dev/null
"${SCRIPT_DIR}/privacy-json-smoke.sh" /tmp/privacy-status-snapshots >/dev/null
"${SCRIPT_DIR}/privacy-ci.sh" /tmp/privacy-status-snapshots >/dev/null
"${SCRIPT_DIR}/privacy-ci.sh" /tmp/privacy-status-snapshots --report-path "${CI_REPORT_MD}" --json >"${CI_PASS_JSON}"
if ! grep -q '"report_path_resolved": "' "${CI_PASS_JSON}"; then
  echo "FAIL: privacy-ci JSON missing report_path_resolved"
  exit 1
fi
if ! grep -q '"report_path_exists": true' "${CI_PASS_JSON}"; then
  echo "FAIL: privacy-ci JSON missing report_path_exists=true"
  exit 1
fi
if [ ! -s "${CI_REPORT_MD}" ]; then
  echo "FAIL: privacy-ci did not produce markdown report artifact"
  exit 1
fi
"${SCRIPT_DIR}/privacy-ci.sh" /tmp/privacy-status-snapshots --report-path "${CI_REPORT_MD}" --report-json-path "${CI_REPORT_JSON}" --json >"${CI_PASS_JSON}"
if ! grep -q '"report_json_path_exists": true' "${CI_PASS_JSON}"; then
  echo "FAIL: privacy-ci JSON missing report_json_path_exists=true"
  exit 1
fi
if ! grep -q '"self_check_once": false' "${CI_PASS_JSON}"; then
  echo "FAIL: privacy-ci JSON missing self_check_once=false default"
  exit 1
fi
if [ ! -s "${CI_REPORT_JSON}" ]; then
  echo "FAIL: privacy-ci did not produce report JSON artifact"
  exit 1
fi

if "${SCRIPT_DIR}/privacy-ci.sh" /tmp/privacy-status-snapshots --with-self-check --self-check-once --json >/dev/null 2>&1; then
  echo "FAIL: privacy-ci accepted conflicting self-check flags"
  exit 1
fi
"${SCRIPT_DIR}/privacy-ci.sh" /tmp/privacy-status-snapshots --require-state artifacts_ready --max-blockers 6 --json >/dev/null
"${SCRIPT_DIR}/privacy-next-step.sh" >/dev/null
"${SCRIPT_DIR}/privacy-next-step.sh" --json >/dev/null
"${SCRIPT_DIR}/privacy-blockers.sh" >/dev/null
"${SCRIPT_DIR}/privacy-blockers.sh" --json >/dev/null
"${SCRIPT_DIR}/privacy-status.sh" --skip-self-check >/dev/null
"${SCRIPT_DIR}/privacy-status.sh" --skip-self-check --json >/dev/null
"${SCRIPT_DIR}/privacy-capture-status.sh" /tmp/privacy-status-snapshots --skip-self-check >/dev/null
"${SCRIPT_DIR}/privacy-capture-status.sh" /tmp/privacy-status-snapshots --skip-self-check --json >/dev/null
"${SCRIPT_DIR}/privacy-prune-snapshots.sh" /tmp/privacy-status-snapshots --keep 20 --dry-run >/dev/null
"${SCRIPT_DIR}/privacy-prune-snapshots.sh" /tmp/privacy-status-snapshots --keep 20 --dry-run --json >/dev/null
"${SCRIPT_DIR}/privacy-compare-snapshots.sh" /tmp/privacy-status-snapshots >/dev/null
"${SCRIPT_DIR}/privacy-compare-snapshots.sh" /tmp/privacy-status-snapshots --json >/dev/null
"${SCRIPT_DIR}/privacy-trend.sh" /tmp/privacy-status-snapshots --limit 5 >/dev/null
"${SCRIPT_DIR}/privacy-trend.sh" /tmp/privacy-status-snapshots --limit 5 --json >/dev/null
"${SCRIPT_DIR}/privacy-refresh.sh" /tmp/privacy-status-snapshots >/dev/null
"${SCRIPT_DIR}/privacy-refresh.sh" /tmp/privacy-status-snapshots --json >/dev/null
"${SCRIPT_DIR}/privacy-refresh.sh" /tmp/privacy-status-snapshots --prune-keep 20 --prune-dry-run >/dev/null
"${SCRIPT_DIR}/privacy-gate.sh" --require-state artifacts_ready --max-blockers 6 >/dev/null
"${SCRIPT_DIR}/privacy-gate.sh" --require-state artifacts_ready --max-blockers 6 --json >/dev/null
"${SCRIPT_DIR}/privacy-refresh-gate.sh" /tmp/privacy-status-snapshots >/dev/null
"${SCRIPT_DIR}/privacy-refresh-gate.sh" /tmp/privacy-status-snapshots --json >/dev/null
"${SCRIPT_DIR}/privacy-refresh-gate.sh" /tmp/privacy-status-snapshots --prune-keep 20 --prune-dry-run >/dev/null
"${SCRIPT_DIR}/privacy-report.sh" /tmp/privacy-status-report.md --snapshot-dir /tmp/privacy-status-snapshots >/dev/null
"${SCRIPT_DIR}/privacy-report.sh" /tmp/privacy-status-report.json --snapshot-dir /tmp/privacy-status-snapshots --json >/dev/null
"${SCRIPT_DIR}/privacy-report.sh" "${REPORT_STRICT_JSON}" --snapshot-dir /tmp/privacy-status-snapshots --strict-gate --json >/dev/null
if ! grep -q '"strict_gate": true' "${REPORT_STRICT_JSON}"; then
  echo "FAIL: privacy-report strict JSON missing strict_gate=true"
  exit 1
fi
if ! grep -q '"gate": {' "${REPORT_STRICT_JSON}"; then
  echo "FAIL: privacy-report strict JSON missing gate object"
  exit 1
fi
if ! grep -q '"gate": {.*"strict_gate": true' "${REPORT_STRICT_JSON}"; then
  if ! awk '
    /"gate":[[:space:]]*{/ { in_gate=1; next }
    in_gate && /}/ { in_gate=0 }
    in_gate && /"strict_gate":[[:space:]]*true/ { found=1 }
    END { exit(found ? 0 : 1) }
  ' "${REPORT_STRICT_JSON}"; then
    echo "FAIL: privacy-report strict JSON missing nested gate.strict_gate=true"
    exit 1
  fi
fi
if ! grep -q '"gate_exit_code": 1' "${REPORT_STRICT_JSON}"; then
  echo "FAIL: privacy-report strict JSON missing gate_exit_code=1"
  exit 1
fi
if ! grep -q '"result": "fail"' "${REPORT_STRICT_JSON}"; then
  echo "FAIL: privacy-report strict JSON missing top-level fail result"
  exit 1
fi

if [ "${FAST_MODE}" = true ]; then
  log "STEP 3b/4: fast mode enabled, skipping expected fail diagnostics"
else
  log "STEP 3b/4: verify expected fail gates still emit diagnostics"

  if "${SCRIPT_DIR}/privacy-gate.sh" --strict-gate --json >"${GATE_FAIL_JSON}"; then
    echo "FAIL: privacy-gate expected fail scenario unexpectedly passed"
    exit 1
  fi

  if ! grep -q '"result": "fail"' "${GATE_FAIL_JSON}"; then
    echo "FAIL: privacy-gate fail JSON missing fail result"
    exit 1
  fi

  if ! grep -q '"strict_gate": true' "${GATE_FAIL_JSON}"; then
    echo "FAIL: privacy-gate fail JSON missing strict_gate=true"
    exit 1
  fi

  if "${SCRIPT_DIR}/privacy-ci.sh" /tmp/privacy-status-snapshots --strict-gate --json >"${CI_FAIL_JSON}"; then
    echo "FAIL: privacy-ci expected fail scenario unexpectedly passed"
    exit 1
  fi

  if ! grep -q '"gate_exit_code": 1' "${CI_FAIL_JSON}"; then
    echo "FAIL: privacy-ci fail JSON missing gate_exit_code"
    exit 1
  fi

  if ! grep -q '"strict_gate": true' "${CI_FAIL_JSON}"; then
    echo "FAIL: privacy-ci fail JSON missing strict_gate=true"
    exit 1
  fi

  if ! grep -q '"result": "fail"' "${CI_FAIL_JSON}"; then
    echo "FAIL: privacy-ci fail JSON missing nested fail result"
    exit 1
  fi

  if "${SCRIPT_DIR}/privacy-refresh-gate.sh" /tmp/privacy-status-snapshots --strict-gate --json >"${GATE_FAIL_JSON}"; then
    echo "FAIL: privacy-refresh-gate expected strict fail scenario unexpectedly passed"
    exit 1
  fi

  if ! grep -q '"strict_gate": true' "${GATE_FAIL_JSON}"; then
    echo "FAIL: privacy-refresh-gate fail JSON missing strict_gate=true"
    exit 1
  fi

  if ! grep -q '"gate_exit_code": 1' "${GATE_FAIL_JSON}"; then
    echo "FAIL: privacy-refresh-gate fail JSON missing gate_exit_code=1"
    exit 1
  fi

  if ! grep -q '"result": "fail"' "${GATE_FAIL_JSON}"; then
    echo "FAIL: privacy-refresh-gate fail JSON missing top-level fail result"
    exit 1
  fi

  if ! grep -q '"gate": {' "${GATE_FAIL_JSON}"; then
    echo "FAIL: privacy-refresh-gate fail JSON missing nested gate object"
    exit 1
  fi

  if ! grep -q '"failures": \[' "${GATE_FAIL_JSON}"; then
    echo "FAIL: privacy-refresh-gate fail JSON missing nested failures list"
    exit 1
  fi
fi

"${SCRIPT_DIR}/prepare-privacy-fastmail-env.sh" --help >/dev/null
"${SCRIPT_DIR}/run-privacy-fastmail-assist.sh" --help >/dev/null
"${SCRIPT_DIR}/show-privacy-rc-readiness.sh" >/dev/null
"${SCRIPT_DIR}/run-privacy-rc-postrun.sh" >/dev/null

log "STEP 4/4: syntax check shell wrappers"
sh -n "${SCRIPT_DIR}/_privacy-wrapper-lib.sh"
sh -n "${SCRIPT_DIR}/_privacy-readiness-lib.sh"
sh -n "${SCRIPT_DIR}/privacy-help.sh"
sh -n "${SCRIPT_DIR}/privacy-json-smoke.sh"
sh -n "${SCRIPT_DIR}/privacy-ci.sh"
sh -n "${SCRIPT_DIR}/privacy-next-step.sh"
sh -n "${SCRIPT_DIR}/privacy-blockers.sh"
sh -n "${SCRIPT_DIR}/privacy-status.sh"
sh -n "${SCRIPT_DIR}/privacy-capture-status.sh"
sh -n "${SCRIPT_DIR}/privacy-prune-snapshots.sh"
sh -n "${SCRIPT_DIR}/privacy-compare-snapshots.sh"
sh -n "${SCRIPT_DIR}/privacy-trend.sh"
sh -n "${SCRIPT_DIR}/privacy-refresh.sh"
sh -n "${SCRIPT_DIR}/privacy-gate.sh"
sh -n "${SCRIPT_DIR}/privacy-refresh-gate.sh"
sh -n "${SCRIPT_DIR}/privacy-report.sh"
sh -n "${SCRIPT_DIR}/run-privacy-stability.sh"
sh -n "${SCRIPT_DIR}/show-privacy-rc-readiness.sh"
sh -n "${SCRIPT_DIR}/run-privacy-rc-postrun.sh"
sh -n "${SCRIPT_DIR}/prepare-privacy-fastmail-env.sh"
sh -n "${SCRIPT_DIR}/run-privacy-fastmail-assist.sh"

if [ "${JSON_MODE}" = true ]; then
  printf '{\n'
  printf '  "result": "pass",\n'
  printf '  "fast_mode": %s,\n' "$( [ "${FAST_MODE}" = true ] && printf 'true' || printf 'false' )"
  printf '  "extended_diagnostics_ran": %s\n' "$( [ "${FAST_MODE}" = true ] && printf 'false' || printf 'true' )"
  printf '}\n'
else
  echo "PASS: privacy tooling self-check completed"
fi
