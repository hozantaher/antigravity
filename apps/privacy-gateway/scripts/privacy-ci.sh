#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SNAPSHOT_DIR="/tmp/privacy-status-snapshots"
REPORT_PATH="/tmp/privacy-status-report.md"
REPORT_JSON_PATH=""
WITH_SELF_CHECK=false
SELF_CHECK_ONCE=false
JSON_MODE=false
PRUNE_KEEP=20
PRUNE_DRY_RUN=true
REQUIRE_STATE="artifacts_ready"
REQUIRE_DECISION=""
MAX_BLOCKERS="6"
STRICT_GATE=false
CUSTOM_REQUIRE_DECISION=false
CUSTOM_MAX_BLOCKERS=false

usage() {
  cat <<'EOF'
Usage:
  ./scripts/privacy-ci.sh [<snapshot-dir>] [--snapshot-dir <dir>] [--report-path <path>] [--report-json-path <path>] [--with-self-check] [--self-check-once] [--json] [--prune-keep <n>] [--prune-apply] [--require-state <state>] [--require-decision <decision>] [--max-blockers <n>] [--strict-gate]

CI flow:
  1) privacy-json-smoke.sh
  2) privacy-refresh-gate.sh (with pruning options)
  3) privacy-report.sh

Defaults:
  --prune-keep 20
  --prune-dry-run (safe mode)
  --require-state artifacts_ready
  --max-blockers 6
  --strict-gate => --require-decision GO --max-blockers 0
  --self-check-once runs privacy-self-check before CI flow
EOF
}

json_escape() {
  printf '%s' "${1:-}" \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

resolve_path() {
  target_path="$1"
  resolved_dir="$(CDPATH= cd -- "$(dirname -- "${target_path}")" && pwd -P)"
  printf '%s/%s' "${resolved_dir}" "$(basename -- "${target_path}")"
}

POSITIONAL_SNAPSHOT_DIR_SET=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --snapshot-dir)
      SNAPSHOT_DIR="${2:-}"
      shift
      ;;
    --report-path)
      REPORT_PATH="${2:-}"
      shift
      ;;
    --report-json-path)
      REPORT_JSON_PATH="${2:-}"
      shift
      ;;
    --with-self-check)
      WITH_SELF_CHECK=true
      ;;
    --self-check-once)
      SELF_CHECK_ONCE=true
      ;;
    --json)
      JSON_MODE=true
      ;;
    --prune-keep)
      PRUNE_KEEP="${2:-}"
      shift
      ;;
    --prune-apply)
      PRUNE_DRY_RUN=false
      ;;
    --require-state)
      REQUIRE_STATE="${2:-}"
      shift
      ;;
    --require-decision)
      REQUIRE_DECISION="${2:-}"
      CUSTOM_REQUIRE_DECISION=true
      shift
      ;;
    --max-blockers)
      MAX_BLOCKERS="${2:-}"
      CUSTOM_MAX_BLOCKERS=true
      shift
      ;;
    --strict-gate)
      STRICT_GATE=true
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      if [ "${POSITIONAL_SNAPSHOT_DIR_SET}" = false ]; then
        SNAPSHOT_DIR="$1"
        POSITIONAL_SNAPSHOT_DIR_SET=true
      else
        echo "FAIL: unsupported argument: $1"
        usage
        exit 1
      fi
      ;;
  esac
  shift
done

case "${PRUNE_KEEP}" in
  ''|*[!0-9]*)
    echo "FAIL: --prune-keep must be a non-negative integer"
    exit 1
    ;;
esac

case "${MAX_BLOCKERS}" in
  ''|*[!0-9]*)
    echo "FAIL: --max-blockers must be a non-negative integer"
    exit 1
    ;;
esac

if [ "${STRICT_GATE}" = true ]; then
  if [ "${CUSTOM_REQUIRE_DECISION}" = true ] || [ "${CUSTOM_MAX_BLOCKERS}" = true ]; then
    echo "FAIL: --strict-gate cannot be combined with --require-decision or --max-blockers"
    exit 1
  fi
  REQUIRE_DECISION="GO"
  MAX_BLOCKERS="0"
fi

if [ "${WITH_SELF_CHECK}" = true ] && [ "${SELF_CHECK_ONCE}" = true ]; then
  echo "FAIL: --with-self-check cannot be combined with --self-check-once"
  exit 1
fi

run_json_smoke() {
  "${SCRIPT_DIR}/privacy-json-smoke.sh" "${SNAPSHOT_DIR}"
}

run_self_check_once_if_requested() {
  if [ "${SELF_CHECK_ONCE}" = true ]; then
    "${SCRIPT_DIR}/privacy-self-check.sh"
  fi
}

run_refresh_gate_with_mode() {
  output_mode="$1"
  set -- "${SCRIPT_DIR}/privacy-refresh-gate.sh" "${SNAPSHOT_DIR}"

  if [ "${WITH_SELF_CHECK}" = true ]; then
    set -- "$@" --with-self-check
  fi

  if [ -n "${PRUNE_KEEP}" ]; then
    set -- "$@" --prune-keep "${PRUNE_KEEP}"
  fi

  if [ "${PRUNE_DRY_RUN}" = true ]; then
    set -- "$@" --prune-dry-run
  fi

  set -- "$@" --require-state "${REQUIRE_STATE}"

  if [ "${STRICT_GATE}" = true ]; then
    set -- "$@" --strict-gate
  else
    set -- "$@" --max-blockers "${MAX_BLOCKERS}"
    if [ -n "${REQUIRE_DECISION}" ]; then
      set -- "$@" --require-decision "${REQUIRE_DECISION}"
    fi
  fi

  if [ "${output_mode}" = "json" ]; then
    set -- "$@" --json
  fi

  "$@"
}

run_refresh_gate_json() {
  run_refresh_gate_with_mode "json"
}

run_refresh_gate_text() {
  run_refresh_gate_with_mode "text"
}

run_report_text() {
  set -- "${SCRIPT_DIR}/privacy-report.sh" "${REPORT_PATH}" --snapshot-dir "${SNAPSHOT_DIR}" --require-state "${REQUIRE_STATE}"

  if [ "${STRICT_GATE}" = true ]; then
    set -- "$@" --strict-gate
  else
    set -- "$@" --max-blockers "${MAX_BLOCKERS}"
    if [ -n "${REQUIRE_DECISION}" ]; then
      set -- "$@" --require-decision "${REQUIRE_DECISION}"
    fi
  fi

  if [ "${WITH_SELF_CHECK}" = true ]; then
    set -- "$@" --with-self-check
  fi

  "$@"
}

run_report_json_optional() {
  if [ -z "${REPORT_JSON_PATH}" ]; then
    return 0
  fi

  set -- "${SCRIPT_DIR}/privacy-report.sh" "${REPORT_JSON_PATH}" --snapshot-dir "${SNAPSHOT_DIR}" --require-state "${REQUIRE_STATE}" --json

  if [ "${STRICT_GATE}" = true ]; then
    set -- "$@" --strict-gate
  else
    set -- "$@" --max-blockers "${MAX_BLOCKERS}"
    if [ -n "${REQUIRE_DECISION}" ]; then
      set -- "$@" --require-decision "${REQUIRE_DECISION}"
    fi
  fi

  if [ "${WITH_SELF_CHECK}" = true ]; then
    set -- "$@" --with-self-check
  fi

  "$@"
}

gate_exit_code=0
refresh_gate_json=""
report_path_resolved=""
report_json_path_resolved=""
report_path_exists=false
report_json_path_exists=false
report_error=""

if [ "${JSON_MODE}" = true ]; then
  run_self_check_once_if_requested >/dev/null
  run_json_smoke >/dev/null
  if refresh_gate_json="$(run_refresh_gate_json)"; then
    gate_exit_code=0
  else
    gate_exit_code=$?
  fi

  if [ -z "${refresh_gate_json}" ]; then
    refresh_gate_json="$(printf '{"result":"error","message":"privacy-refresh-gate produced no JSON output","exit_code":%s}' "${gate_exit_code}")"
  fi

  run_report_text >/dev/null
  run_report_json_optional >/dev/null
  report_path_resolved="$(resolve_path "${REPORT_PATH}")"
  if [ -n "${REPORT_JSON_PATH}" ]; then
    report_json_path_resolved="$(resolve_path "${REPORT_JSON_PATH}")"
  fi

  if [ -s "${REPORT_PATH}" ]; then
    report_path_exists=true
  else
    report_error="markdown report missing or empty: ${REPORT_PATH}"
  fi

  if [ -n "${REPORT_JSON_PATH}" ]; then
    if [ -s "${REPORT_JSON_PATH}" ]; then
      report_json_path_exists=true
    else
      if [ -n "${report_error}" ]; then
        report_error="${report_error}; json report missing or empty: ${REPORT_JSON_PATH}"
      else
        report_error="json report missing or empty: ${REPORT_JSON_PATH}"
      fi
    fi
  fi

  final_exit_code="${gate_exit_code}"
  if [ -n "${report_error}" ] && [ "${final_exit_code}" -eq 0 ]; then
    final_exit_code=1
  fi

  printf '{\n'
  printf '  "result": "%s",\n' "$( [ "${final_exit_code}" -eq 0 ] && printf 'pass' || printf 'fail' )"
  printf '  "snapshot_dir": "%s",\n' "$(json_escape "${SNAPSHOT_DIR}")"
  printf '  "report_path": "%s",\n' "$(json_escape "${REPORT_PATH}")"
  printf '  "report_path_resolved": "%s",\n' "$(json_escape "${report_path_resolved}")"
  printf '  "report_path_exists": %s,\n' "$( [ "${report_path_exists}" = true ] && printf 'true' || printf 'false' )"
  printf '  "report_json_path": "%s",\n' "$(json_escape "${REPORT_JSON_PATH}")"
  printf '  "report_json_path_resolved": "%s",\n' "$(json_escape "${report_json_path_resolved}")"
  printf '  "report_json_path_exists": %s,\n' "$( [ "${report_json_path_exists}" = true ] && printf 'true' || printf 'false' )"
  printf '  "prune_keep": %s,\n' "${PRUNE_KEEP}"
  printf '  "prune_dry_run": %s,\n' "$( [ "${PRUNE_DRY_RUN}" = true ] && printf 'true' || printf 'false' )"
  printf '  "with_self_check": %s,\n' "$( [ "${WITH_SELF_CHECK}" = true ] && printf 'true' || printf 'false' )"
  printf '  "self_check_once": %s,\n' "$( [ "${SELF_CHECK_ONCE}" = true ] && printf 'true' || printf 'false' )"
  printf '  "strict_gate": %s,\n' "$( [ "${STRICT_GATE}" = true ] && printf 'true' || printf 'false' )"
  printf '  "gate_requirements": {\n'
  printf '    "state": "%s",\n' "$(json_escape "${REQUIRE_STATE}")"
  printf '    "decision": "%s",\n' "$(json_escape "${REQUIRE_DECISION}")"
  printf '    "max_blockers": %s\n' "${MAX_BLOCKERS}"
  printf '  },\n'
  printf '  "json_smoke": "pass",\n'
  printf '  "report_error": "%s",\n' "$(json_escape "${report_error}")"
  printf '  "gate_exit_code": %s,\n' "${gate_exit_code}"
  printf '  "refresh_gate": %s\n' "${refresh_gate_json}"
  printf '}\n'
  if [ "${final_exit_code}" -ne 0 ]; then
    exit "${final_exit_code}"
  fi
  exit 0
fi

if [ "${SELF_CHECK_ONCE}" = true ]; then
  echo "STEP 0/4: run privacy self-check once"
  run_self_check_once_if_requested
  echo
  echo "STEP 1/4: JSON smoke checks"
else
  echo "STEP 1/3: JSON smoke checks"
fi
run_json_smoke

echo
if [ "${SELF_CHECK_ONCE}" = true ]; then
  echo "STEP 2/4: refresh + gate"
else
  echo "STEP 2/3: refresh + gate"
fi
if run_refresh_gate_text; then
  gate_exit_code=0
else
  gate_exit_code=$?
  echo "WARN: gate checks failed with exit code ${gate_exit_code}; continuing to generate report"
fi

echo
if [ "${SELF_CHECK_ONCE}" = true ]; then
  echo "STEP 3/4: generate markdown report"
else
  echo "STEP 3/3: generate markdown report"
fi
run_report_text
run_report_json_optional

if [ ! -s "${REPORT_PATH}" ]; then
  echo "FAIL: markdown report missing or empty: ${REPORT_PATH}"
  exit 1
fi

if [ -n "${REPORT_JSON_PATH}" ] && [ ! -s "${REPORT_JSON_PATH}" ]; then
  echo "FAIL: json report missing or empty: ${REPORT_JSON_PATH}"
  exit 1
fi

if [ "${gate_exit_code}" -ne 0 ]; then
  exit "${gate_exit_code}"
fi
