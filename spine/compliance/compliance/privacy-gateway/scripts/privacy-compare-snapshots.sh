#!/bin/sh

set -eu

DEFAULT_DIR="/tmp/privacy-status-snapshots"
SNAPSHOT_DIR="${DEFAULT_DIR}"
JSON_MODE=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --json)
      JSON_MODE=true
      ;;
    --help|-h)
      cat <<'EOF'
Usage:
  ./scripts/privacy-compare-snapshots.sh [snapshot-dir] [--json]

Compares the two newest privacy status JSON snapshots and prints key deltas.
Options:
  --json  Print machine-readable JSON output.
EOF
      exit 0
      ;;
    *)
      if [ "${SNAPSHOT_DIR}" = "${DEFAULT_DIR}" ]; then
        SNAPSHOT_DIR="$1"
      else
        echo "FAIL: unsupported extra argument: $1"
        exit 1
      fi
      ;;
  esac
  shift
done

if [ ! -d "${SNAPSHOT_DIR}" ]; then
  echo "FAIL: snapshot directory not found: ${SNAPSHOT_DIR}"
  exit 1
fi

latest_files="$(ls -1t "${SNAPSHOT_DIR}"/privacy-status-*.json 2>/dev/null | head -n 2 || true)"
latest_count="$(printf '%s\n' "${latest_files}" | sed '/^$/d' | wc -l | tr -d ' ')"

if [ "${latest_count}" -lt 2 ]; then
  echo "FAIL: need at least two snapshot JSON files in ${SNAPSHOT_DIR}"
  exit 1
fi

NEW_FILE="$(printf '%s\n' "${latest_files}" | sed -n '1p')"
OLD_FILE="$(printf '%s\n' "${latest_files}" | sed -n '2p')"

extract_json_string() {
  key="$1"
  file="$2"
  sed -n "s/.*\"${key}\": \"\\([^\"]*\\)\".*/\\1/p" "${file}" | head -n 1
}

json_escape() {
  printf '%s' "${1:-}" \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
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

new_decision="$(extract_json_string "snapshot_decision" "${NEW_FILE}")"
old_decision="$(extract_json_string "snapshot_decision" "${OLD_FILE}")"
new_sprint="$(extract_json_string "sprint_6_status" "${NEW_FILE}")"
old_sprint="$(extract_json_string "sprint_6_status" "${OLD_FILE}")"
new_state="$(extract_json_string "state" "${NEW_FILE}")"
old_state="$(extract_json_string "state" "${OLD_FILE}")"
new_blockers="$(extract_blocker_count "${NEW_FILE}")"
old_blockers="$(extract_blocker_count "${OLD_FILE}")"

summary="key status changed"
if [ "${old_decision}" = "${new_decision}" ] && \
   [ "${old_sprint}" = "${new_sprint}" ] && \
   [ "${old_state}" = "${new_state}" ] && \
   [ "${old_blockers}" = "${new_blockers}" ]; then
  summary="no key status change detected"
fi

if [ "${JSON_MODE}" = true ]; then
  printf '{\n'
  printf '  "snapshot_dir": "%s",\n' "$(json_escape "${SNAPSHOT_DIR}")"
  printf '  "new_file": "%s",\n' "$(json_escape "${NEW_FILE}")"
  printf '  "old_file": "%s",\n' "$(json_escape "${OLD_FILE}")"
  printf '  "changes": {\n'
  printf '    "decision": { "from": "%s", "to": "%s" },\n' "$(json_escape "${old_decision:-unknown}")" "$(json_escape "${new_decision:-unknown}")"
  printf '    "sprint_6_status": { "from": "%s", "to": "%s" },\n' "$(json_escape "${old_sprint:-unknown}")" "$(json_escape "${new_sprint:-unknown}")"
  printf '    "next_step_state": { "from": "%s", "to": "%s" },\n' "$(json_escape "${old_state:-unknown}")" "$(json_escape "${new_state:-unknown}")"
  printf '    "blocker_count": { "from": %s, "to": %s }\n' "${old_blockers}" "${new_blockers}"
  printf '  },\n'
  printf '  "summary": "%s"\n' "$(json_escape "${summary}")"
  printf '}\n'
  exit 0
fi

echo "Privacy Snapshot Comparison"
echo "- new: ${NEW_FILE}"
echo "- old: ${OLD_FILE}"
echo
echo "Key fields:"
echo "- decision: ${old_decision:-unknown} -> ${new_decision:-unknown}"
echo "- sprint_6_status: ${old_sprint:-unknown} -> ${new_sprint:-unknown}"
echo "- next_step.state: ${old_state:-unknown} -> ${new_state:-unknown}"
echo "- blocker_count: ${old_blockers} -> ${new_blockers}"
echo

if [ "${summary}" = "no key status change detected" ]; then
  echo "Summary: no key status change detected."
  exit 0
fi

echo "Summary: key status changed."
