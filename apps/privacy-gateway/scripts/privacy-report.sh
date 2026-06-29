#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
OUTPUT_PATH=""
SNAPSHOT_DIR="/tmp/privacy-status-snapshots"
WITH_SELF_CHECK=false
JSON_MODE=false
REQUIRE_STATE="artifacts_ready"
REQUIRE_DECISION=""
MAX_BLOCKERS="6"
STRICT_GATE=false
CUSTOM_REQUIRE_DECISION=false
CUSTOM_MAX_BLOCKERS=false

usage() {
  cat <<'EOF'
Usage:
  ./scripts/privacy-report.sh [output-path] [--snapshot-dir <dir>] [--with-self-check] [--json] [--require-state <state>] [--require-decision <decision>] [--max-blockers <n>] [--strict-gate]

Generates a privacy status report with:
  - current status summary
  - latest snapshot comparison summary
  - gate result
  - blocker list

Options:
  --json  Generate JSON report (default: /tmp/privacy-status-report.json).
  --strict-gate => --require-decision GO --max-blockers 0
EOF
}

extract_json_string() {
  key="$1"
  json="$2"
  printf '%s\n' "${json}" | sed -n "s/.*\"${key}\": \"\\([^\"]*\\)\".*/\\1/p" | head -n 1
}

json_escape() {
  printf '%s' "${1:-}" \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --snapshot-dir)
      SNAPSHOT_DIR="${2:-}"
      shift
      ;;
    --with-self-check)
      WITH_SELF_CHECK=true
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
    --json)
      JSON_MODE=true
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      if [ -z "${OUTPUT_PATH}" ]; then
        OUTPUT_PATH="$1"
      else
        echo "FAIL: unsupported extra argument: $1"
        usage
        exit 1
      fi
      ;;
  esac
  shift
done

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

if [ -z "${OUTPUT_PATH}" ]; then
  if [ "${JSON_MODE}" = true ]; then
    OUTPUT_PATH="/tmp/privacy-status-report.json"
  else
    OUTPUT_PATH="/tmp/privacy-status-report.md"
  fi
fi

mkdir -p "$(dirname "${OUTPUT_PATH}")"

if [ "${WITH_SELF_CHECK}" = true ]; then
  capture_json="$("${SCRIPT_DIR}/privacy-capture-status.sh" "${SNAPSHOT_DIR}" --json)"
  status_json="$("${SCRIPT_DIR}/privacy-status.sh" --json)"
else
  capture_json="$("${SCRIPT_DIR}/privacy-capture-status.sh" "${SNAPSHOT_DIR}" --skip-self-check --json)"
  status_json="$("${SCRIPT_DIR}/privacy-status.sh" --skip-self-check --json)"
fi

compare_json="$("${SCRIPT_DIR}/privacy-compare-snapshots.sh" "${SNAPSHOT_DIR}" --json || true)"

run_gate_json() {
  set -- "${SCRIPT_DIR}/privacy-gate.sh" --require-state "${REQUIRE_STATE}"
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
  set -- "$@" --json
  "$@"
}

gate_exit_code=0
if gate_json="$(run_gate_json)"; then
  gate_exit_code=0
else
  gate_exit_code=$?
fi

if [ -z "${gate_json}" ]; then
  gate_json="$(printf '{"result":"error","message":"privacy-gate produced no JSON output","exit_code":%s}' "${gate_exit_code}")"
fi

blockers_json="$("${SCRIPT_DIR}/privacy-blockers.sh" --json)"
next_json="$("${SCRIPT_DIR}/privacy-next-step.sh" --json)"
blockers_text="$("${SCRIPT_DIR}/privacy-blockers.sh")"
next_step_text="$("${SCRIPT_DIR}/privacy-next-step.sh")"

decision="$(extract_json_string "snapshot_decision" "${status_json}")"
sprint6="$(extract_json_string "sprint_6_status" "${status_json}")"
state="$(extract_json_string "state" "${status_json}")"
gate_result="$(extract_json_string "result" "${gate_json}")"
compare_summary="$(extract_json_string "summary" "${compare_json}")"
blocker_count="$(printf '%s\n' "${gate_json}" | sed -n 's/.*"blocker_count": \([0-9][0-9]*\).*/\1/p' | head -n 1)"

if [ "${JSON_MODE}" = true ]; then
  {
    printf '{\n'
    printf '  "result": "%s",\n' "$( [ "${gate_exit_code}" -eq 0 ] && printf 'pass' || printf 'fail' )"
    printf '  "gate_exit_code": %s,\n' "${gate_exit_code}"
    printf '  "generated_at": "%s",\n' "$(json_escape "$(date '+%Y-%m-%d %H:%M:%S %z')")"
    printf '  "snapshot_dir": "%s",\n' "$(json_escape "${SNAPSHOT_DIR}")"
    printf '  "strict_gate": %s,\n' "$( [ "${STRICT_GATE}" = true ] && printf 'true' || printf 'false' )"
    printf '  "gate_requirements": {\n'
    printf '    "state": "%s",\n' "$(json_escape "${REQUIRE_STATE}")"
    printf '    "decision": "%s",\n' "$(json_escape "${REQUIRE_DECISION}")"
    printf '    "max_blockers": "%s"\n' "$(json_escape "${MAX_BLOCKERS}")"
    printf '  },\n'
    printf '  "capture": %s,\n' "${capture_json}"
    printf '  "status": %s,\n' "${status_json}"
    printf '  "comparison": %s,\n' "${compare_json}"
    printf '  "gate": %s,\n' "${gate_json}"
    printf '  "blockers": %s,\n' "${blockers_json}"
    printf '  "next_step": %s\n' "${next_json}"
    printf '}\n'
  } >"${OUTPUT_PATH}"
else
  {
    echo "# Privacy Status Report"
    echo
    echo "- generated: $(date '+%Y-%m-%d %H:%M:%S %z')"
    echo "- snapshot dir: ${SNAPSHOT_DIR}"
    echo
    echo "## Current Status"
    echo
    echo "- decision: ${decision:-unknown}"
    echo "- sprint 6: ${sprint6:-unknown}"
    echo "- next_step.state: ${state:-unknown}"
    echo "- blocker_count: ${blocker_count:-unknown}"
    echo "- gate result: ${gate_result:-unknown}"
    echo "- gate requirements: state=${REQUIRE_STATE}, decision=${REQUIRE_DECISION:-<any>}, max_blockers=${MAX_BLOCKERS}, strict_gate=${STRICT_GATE}"
    echo
    echo "## Snapshot Comparison"
    echo
    echo "- summary: ${compare_summary:-unknown}"
    echo
    echo "## Blockers"
    echo
    printf '%s\n' "${blockers_text}" | sed -n '/^Remaining blockers:/,$p' | sed '1d'
    echo
    echo "## Suggested Next Step"
    echo
    printf '%s\n' "${next_step_text}" | sed -n '/^Suggested next move:/,$p'
  } >"${OUTPUT_PATH}"
fi

echo "WROTE: ${OUTPUT_PATH}"
resolved_dir="$(CDPATH= cd -- "$(dirname -- "${OUTPUT_PATH}")" && pwd -P)"
echo "WROTE_RESOLVED: ${resolved_dir}/$(basename -- "${OUTPUT_PATH}")"
echo "PASS: privacy report generated"
