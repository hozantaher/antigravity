#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

REQUIRE_STATE=""
MAX_BLOCKERS=""
REQUIRE_DECISION=""
SKIP_SELF_CHECK=true
JSON_MODE=false
STRICT_GATE=false
CUSTOM_REQUIRE_DECISION=false
CUSTOM_MAX_BLOCKERS=false

usage() {
  cat <<'EOF'
Usage:
  ./scripts/privacy-gate.sh [--require-state <state>] [--require-decision <decision>] [--max-blockers <n>] [--strict-gate] [--with-self-check] [--json]

Examples:
  ./scripts/privacy-gate.sh --max-blockers 0
  ./scripts/privacy-gate.sh --require-state artifacts_ready --max-blockers 6
  ./scripts/privacy-gate.sh --strict-gate
  ./scripts/privacy-gate.sh --require-decision GO --max-blockers 0
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
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
    --with-self-check)
      SKIP_SELF_CHECK=false
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

if [ -n "${MAX_BLOCKERS}" ]; then
  case "${MAX_BLOCKERS}" in
    ''|*[!0-9]*)
      echo "FAIL: --max-blockers must be a non-negative integer"
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

STATUS_JSON_ARGS="--json"
if [ "${SKIP_SELF_CHECK}" = true ]; then
  STATUS_JSON_ARGS="--skip-self-check --json"
fi

status_json="$("${SCRIPT_DIR}/privacy-status.sh" ${STATUS_JSON_ARGS})"

extract_json_string() {
  key="$1"
  printf '%s\n' "${status_json}" | sed -n "s/.*\"${key}\": \"\\([^\"]*\\)\".*/\\1/p" | head -n 1
}

json_escape() {
  printf '%s' "${1:-}" \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

extract_blocker_count() {
  printf '%s\n' "${status_json}" | awk '
    /"blocker_details":[[:space:]]*{/ { in_blockers=1; next }
    in_blockers && /"blockers":[[:space:]]*\[/ { in_array=1; next }
    in_array && /\]/ { print count+0; exit }
    in_array && /^[[:space:]]*"/ { count++ }
    END { if (!count) print 0 }
  ' | head -n 1
}

state="$(extract_json_string "state")"
decision="$(extract_json_string "snapshot_decision")"
blocker_count="$(extract_blocker_count)"

failed=false
failure_reasons=""

if [ -n "${REQUIRE_STATE}" ] && [ "${state}" != "${REQUIRE_STATE}" ]; then
  failed=true
  failure_reasons="${failure_reasons}
required state '${REQUIRE_STATE}', got '${state}'"
fi

if [ -n "${REQUIRE_DECISION}" ] && [ "${decision}" != "${REQUIRE_DECISION}" ]; then
  failed=true
  failure_reasons="${failure_reasons}
required decision '${REQUIRE_DECISION}', got '${decision}'"
fi

if [ -n "${MAX_BLOCKERS}" ] && [ "${blocker_count}" -gt "${MAX_BLOCKERS}" ]; then
  failed=true
  failure_reasons="${failure_reasons}
blocker_count ${blocker_count} > max ${MAX_BLOCKERS}"
fi

if [ "${JSON_MODE}" = true ]; then
  printf '{\n'
  printf '  "result": "%s",\n' "$( [ "${failed}" = true ] && printf 'fail' || printf 'pass' )"
  printf '  "state": "%s",\n' "$(json_escape "${state:-unknown}")"
  printf '  "decision": "%s",\n' "$(json_escape "${decision:-unknown}")"
  printf '  "blocker_count": %s,\n' "${blocker_count}"
  printf '  "strict_gate": %s,\n' "$( [ "${STRICT_GATE}" = true ] && printf 'true' || printf 'false' )"
  printf '  "requirements": {\n'
  printf '    "state": "%s",\n' "$(json_escape "${REQUIRE_STATE}")"
  printf '    "decision": "%s",\n' "$(json_escape "${REQUIRE_DECISION}")"
  printf '    "max_blockers": "%s"\n' "$(json_escape "${MAX_BLOCKERS}")"
  printf '  },\n'
  printf '  "failures": [\n'
  first=true
  while IFS= read -r reason; do
    [ -z "${reason}" ] && continue
    if [ "${first}" = true ]; then
      first=false
    else
      printf ',\n'
    fi
    printf '    "%s"' "$(json_escape "${reason}")"
  done <<EOF
${failure_reasons}
EOF
  printf '\n  ]\n'
  printf '}\n'
  if [ "${failed}" = true ]; then
    exit 1
  fi
  exit 0
fi

echo "Privacy Gate"
echo "- state: ${state:-unknown}"
echo "- decision: ${decision:-unknown}"
echo "- blocker_count: ${blocker_count}"

if [ "${failed}" = true ]; then
  while IFS= read -r reason; do
    [ -z "${reason}" ] && continue
    echo "FAIL: ${reason}"
  done <<EOF
${failure_reasons}
EOF
  exit 1
fi

echo "PASS: privacy gate satisfied"
