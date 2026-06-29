#!/bin/sh

set -eu

SNAPSHOT_DIR="/tmp/privacy-status-snapshots"
LIMIT=5
JSON_MODE=false

usage() {
  cat <<'EOF'
Usage:
  ./scripts/privacy-trend.sh [snapshot-dir] [--limit <n>] [--json]

Shows trend across recent privacy status snapshots.
Default limit: 5
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --limit)
      LIMIT="${2:-}"
      shift
      ;;
    --json)
      JSON_MODE=true
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

case "${LIMIT}" in
  ''|*[!0-9]*)
    echo "FAIL: --limit must be a positive integer"
    exit 1
    ;;
esac

if [ "${LIMIT}" -eq 0 ]; then
  echo "FAIL: --limit must be greater than 0"
  exit 1
fi

if [ ! -d "${SNAPSHOT_DIR}" ]; then
  echo "FAIL: snapshot directory not found: ${SNAPSHOT_DIR}"
  exit 1
fi

files="$(ls -1t "${SNAPSHOT_DIR}"/privacy-status-*.json 2>/dev/null | head -n "${LIMIT}" || true)"
count="$(printf '%s\n' "${files}" | sed '/^$/d' | wc -l | tr -d ' ')"

if [ "${count}" -eq 0 ]; then
  echo "FAIL: no snapshot JSON files found in ${SNAPSHOT_DIR}"
  exit 1
fi

extract_json_string() {
  key="$1"
  file="$2"
  sed -n "s/.*\"${key}\": \"\\([^\"]*\\)\".*/\\1/p" "${file}" | head -n 1
}

extract_blocker_count() {
  file="$1"
  awk '
    /"blocker_details":[[:space:]]*{/ { in_blockers=1; next }
    in_blockers && /"blockers":[[:space:]]*\[/ { in_array=1; next }
    in_array && /\]/ { in_array=0; in_blockers=0; print count+0; exit }
    in_array && /^[[:space:]]*"/ { count++ }
    END { if (!count) print 0 }
  ' "${file}" | head -n 1
}

json_escape() {
  printf '%s' "${1:-}" \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

if [ "${JSON_MODE}" = true ]; then
  printf '{\n'
  printf '  "snapshot_dir": "%s",\n' "$(json_escape "${SNAPSHOT_DIR}")"
  printf '  "limit": %s,\n' "${LIMIT}"
  printf '  "count": %s,\n' "${count}"
  printf '  "entries": [\n'
  idx=0
  while IFS= read -r file; do
    [ -z "${file}" ] && continue
    stamp="$(basename "${file}" | sed -n 's/^privacy-status-\(.*\)\.json$/\1/p')"
    decision="$(extract_json_string "snapshot_decision" "${file}")"
    sprint6="$(extract_json_string "sprint_6_status" "${file}")"
    state="$(extract_json_string "state" "${file}")"
    blockers="$(extract_blocker_count "${file}")"
    if [ "${idx}" -gt 0 ]; then
      printf ',\n'
    fi
    printf '    { "stamp": "%s", "decision": "%s", "sprint_6_status": "%s", "state": "%s", "blocker_count": %s, "file": "%s" }' \
      "$(json_escape "${stamp}")" \
      "$(json_escape "${decision:-unknown}")" \
      "$(json_escape "${sprint6:-unknown}")" \
      "$(json_escape "${state:-unknown}")" \
      "${blockers}" \
      "$(json_escape "${file}")"
    idx=$((idx + 1))
  done <<EOF
${files}
EOF
  printf '\n  ]\n'
  printf '}\n'
  exit 0
fi

echo "Privacy Trend"
echo "- snapshot_dir: ${SNAPSHOT_DIR}"
echo "- limit: ${LIMIT}"
echo "- count: ${count}"
echo
echo "Recent snapshots (newest first):"
while IFS= read -r file; do
  [ -z "${file}" ] && continue
  stamp="$(basename "${file}" | sed -n 's/^privacy-status-\(.*\)\.json$/\1/p')"
  decision="$(extract_json_string "snapshot_decision" "${file}")"
  sprint6="$(extract_json_string "sprint_6_status" "${file}")"
  state="$(extract_json_string "state" "${file}")"
  blockers="$(extract_blocker_count "${file}")"
  echo "- ${stamp}: decision=${decision:-unknown}, sprint6=${sprint6:-unknown}, state=${state:-unknown}, blockers=${blockers}"
done <<EOF
${files}
EOF
