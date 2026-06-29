#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SNAPSHOT_DIR="/tmp/privacy-status-snapshots"
JSON_MODE=false
WITH_SELF_CHECK=false
REQUIRE_STATE="artifacts_ready"
REQUIRE_DECISION=""
MAX_BLOCKERS="6"
PRUNE_KEEP=""
PRUNE_DRY_RUN=false
STRICT_GATE=false
CUSTOM_REQUIRE_DECISION=false
CUSTOM_MAX_BLOCKERS=false

usage() {
  cat <<'EOF'
Usage:
  ./scripts/privacy-refresh-gate.sh [snapshot-dir] [--with-self-check] [--json] [--require-state <state>] [--require-decision <decision>] [--max-blockers <n>] [--prune-keep <n>] [--prune-dry-run] [--strict-gate]

Runs:
  1) privacy-refresh.sh
  2) privacy-gate.sh

Default gate settings:
  --require-state artifacts_ready
  --max-blockers 6
  --strict-gate => --require-decision GO --max-blockers 0

Examples:
  ./scripts/privacy-refresh-gate.sh
  ./scripts/privacy-refresh-gate.sh --strict-gate
  ./scripts/privacy-refresh-gate.sh --require-decision GO --max-blockers 0
  ./scripts/privacy-refresh-gate.sh --prune-keep 20
  ./scripts/privacy-refresh-gate.sh --json
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --with-self-check)
      WITH_SELF_CHECK=true
      ;;
    --json)
      JSON_MODE=true
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
    --prune-keep)
      PRUNE_KEEP="${2:-}"
      shift
      ;;
    --prune-dry-run)
      PRUNE_DRY_RUN=true
      ;;
    --strict-gate)
      STRICT_GATE=true
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      if [ "${SNAPSHOT_DIR}" = "/tmp/privacy-status-snapshots" ]; then
        SNAPSHOT_DIR="$1"
      else
        echo "FAIL: unsupported extra argument: $1"
        usage
        exit 1
      fi
      ;;
  esac
  shift
done

if [ -n "${MAX_BLOCKERS}" ]; then
  case "${MAX_BLOCKERS}" in
    ''|*[!0-9]*)
      echo "FAIL: --max-blockers must be a non-negative integer"
      exit 1
      ;;
  esac
fi

if [ -n "${PRUNE_KEEP}" ]; then
  case "${PRUNE_KEEP}" in
    ''|*[!0-9]*)
      echo "FAIL: --prune-keep must be a non-negative integer"
      exit 1
      ;;
  esac
fi

if [ "${STRICT_GATE}" = true ]; then
  if [ "${CUSTOM_REQUIRE_DECISION}" = true ] || [ "${CUSTOM_MAX_BLOCKERS}" = true ]; then
    echo "FAIL: --strict-gate cannot be combined with --require-decision or --max-blockers"
    exit 1
  fi
  REQUIRE_DECISION="GO"
  MAX_BLOCKERS="0"
fi

run_refresh_json() {
  if [ "${WITH_SELF_CHECK}" = true ]; then
    if [ -n "${PRUNE_KEEP}" ]; then
      if [ "${PRUNE_DRY_RUN}" = true ]; then
        "${SCRIPT_DIR}/privacy-refresh.sh" "${SNAPSHOT_DIR}" --with-self-check --prune-keep "${PRUNE_KEEP}" --prune-dry-run --json
      else
        "${SCRIPT_DIR}/privacy-refresh.sh" "${SNAPSHOT_DIR}" --with-self-check --prune-keep "${PRUNE_KEEP}" --json
      fi
    else
      "${SCRIPT_DIR}/privacy-refresh.sh" "${SNAPSHOT_DIR}" --with-self-check --json
    fi
  else
    if [ -n "${PRUNE_KEEP}" ]; then
      if [ "${PRUNE_DRY_RUN}" = true ]; then
        "${SCRIPT_DIR}/privacy-refresh.sh" "${SNAPSHOT_DIR}" --prune-keep "${PRUNE_KEEP}" --prune-dry-run --json
      else
        "${SCRIPT_DIR}/privacy-refresh.sh" "${SNAPSHOT_DIR}" --prune-keep "${PRUNE_KEEP}" --json
      fi
    else
      "${SCRIPT_DIR}/privacy-refresh.sh" "${SNAPSHOT_DIR}" --json
    fi
  fi
}

run_refresh_text() {
  if [ "${WITH_SELF_CHECK}" = true ]; then
    if [ -n "${PRUNE_KEEP}" ]; then
      if [ "${PRUNE_DRY_RUN}" = true ]; then
        "${SCRIPT_DIR}/privacy-refresh.sh" "${SNAPSHOT_DIR}" --with-self-check --prune-keep "${PRUNE_KEEP}" --prune-dry-run
      else
        "${SCRIPT_DIR}/privacy-refresh.sh" "${SNAPSHOT_DIR}" --with-self-check --prune-keep "${PRUNE_KEEP}"
      fi
    else
      "${SCRIPT_DIR}/privacy-refresh.sh" "${SNAPSHOT_DIR}" --with-self-check
    fi
  else
    if [ -n "${PRUNE_KEEP}" ]; then
      if [ "${PRUNE_DRY_RUN}" = true ]; then
        "${SCRIPT_DIR}/privacy-refresh.sh" "${SNAPSHOT_DIR}" --prune-keep "${PRUNE_KEEP}" --prune-dry-run
      else
        "${SCRIPT_DIR}/privacy-refresh.sh" "${SNAPSHOT_DIR}" --prune-keep "${PRUNE_KEEP}"
      fi
    else
      "${SCRIPT_DIR}/privacy-refresh.sh" "${SNAPSHOT_DIR}"
    fi
  fi
}

run_gate_json() {
  gate_self_check_flag=""
  gate_strict_flag=""
  if [ "${WITH_SELF_CHECK}" = true ]; then
    gate_self_check_flag="--with-self-check"
  fi
  if [ "${STRICT_GATE}" = true ]; then
    gate_strict_flag="--strict-gate"
  fi

  if [ "${STRICT_GATE}" = true ]; then
    "${SCRIPT_DIR}/privacy-gate.sh" ${gate_self_check_flag} ${gate_strict_flag} --require-state "${REQUIRE_STATE}" --json
  elif [ -n "${REQUIRE_DECISION}" ]; then
    "${SCRIPT_DIR}/privacy-gate.sh" ${gate_self_check_flag} --require-state "${REQUIRE_STATE}" --require-decision "${REQUIRE_DECISION}" --max-blockers "${MAX_BLOCKERS}" --json
  else
    "${SCRIPT_DIR}/privacy-gate.sh" ${gate_self_check_flag} --require-state "${REQUIRE_STATE}" --max-blockers "${MAX_BLOCKERS}" --json
  fi
}

run_gate_text() {
  gate_self_check_flag=""
  gate_strict_flag=""
  if [ "${WITH_SELF_CHECK}" = true ]; then
    gate_self_check_flag="--with-self-check"
  fi
  if [ "${STRICT_GATE}" = true ]; then
    gate_strict_flag="--strict-gate"
  fi

  if [ "${STRICT_GATE}" = true ]; then
    "${SCRIPT_DIR}/privacy-gate.sh" ${gate_self_check_flag} ${gate_strict_flag} --require-state "${REQUIRE_STATE}"
  elif [ -n "${REQUIRE_DECISION}" ]; then
    "${SCRIPT_DIR}/privacy-gate.sh" ${gate_self_check_flag} --require-state "${REQUIRE_STATE}" --require-decision "${REQUIRE_DECISION}" --max-blockers "${MAX_BLOCKERS}"
  else
    "${SCRIPT_DIR}/privacy-gate.sh" ${gate_self_check_flag} --require-state "${REQUIRE_STATE}" --max-blockers "${MAX_BLOCKERS}"
  fi
}

if [ "${JSON_MODE}" = true ]; then
  refresh_json="$(run_refresh_json)"
  gate_exit_code=0
  if gate_json="$(run_gate_json)"; then
    gate_exit_code=0
  else
    gate_exit_code=$?
  fi

  if [ -z "${gate_json}" ]; then
    gate_json="$(printf '{"result":"error","message":"privacy-gate produced no JSON output","exit_code":%s}' "${gate_exit_code}")"
  fi

  printf '{\n'
  printf '  "result": "%s",\n' "$( [ "${gate_exit_code}" -eq 0 ] && printf 'pass' || printf 'fail' )"
  printf '  "gate_exit_code": %s,\n' "${gate_exit_code}"
  printf '  "snapshot_dir": "%s",\n' "${SNAPSHOT_DIR}"
  printf '  "strict_gate": %s,\n' "$( [ "${STRICT_GATE}" = true ] && printf 'true' || printf 'false' )"
  printf '  "gate_requirements": {\n'
  printf '    "state": "%s",\n' "${REQUIRE_STATE}"
  printf '    "decision": "%s",\n' "${REQUIRE_DECISION}"
  printf '    "max_blockers": "%s"\n' "${MAX_BLOCKERS}"
  printf '  },\n'
  printf '  "refresh": %s,\n' "${refresh_json}"
  printf '  "gate": %s\n' "${gate_json}"
  printf '}\n'

  if [ "${gate_exit_code}" -ne 0 ]; then
    exit "${gate_exit_code}"
  fi
  exit 0
fi

echo "STEP 1/2: refresh privacy status"
run_refresh_text

echo
echo "STEP 2/2: run privacy gate"
run_gate_text
