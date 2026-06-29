#!/bin/sh

set -eu

SNAPSHOT_DIR="/tmp/privacy-status-snapshots"
KEEP=20
DRY_RUN=false
JSON_MODE=false

usage() {
  cat <<'EOF'
Usage:
  ./scripts/privacy-prune-snapshots.sh [snapshot-dir] [--keep <n>] [--dry-run] [--json]

Keeps only the newest N privacy snapshot pairs (*.txt + *.json).
Files affected:
  privacy-status-*.txt
  privacy-status-*.json
  latest.txt
  latest.json
EOF
}

json_escape() {
  printf '%s' "${1:-}" \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --keep)
      KEEP="${2:-}"
      shift
      ;;
    --dry-run)
      DRY_RUN=true
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

case "${KEEP}" in
  ''|*[!0-9]*)
    echo "FAIL: --keep must be a non-negative integer"
    exit 1
    ;;
esac

if [ ! -d "${SNAPSHOT_DIR}" ]; then
  echo "FAIL: snapshot directory not found: ${SNAPSHOT_DIR}"
  exit 1
fi

json_files="$(ls -1t "${SNAPSHOT_DIR}"/privacy-status-*.json 2>/dev/null || true)"
total="$(printf '%s\n' "${json_files}" | sed '/^$/d' | wc -l | tr -d ' ')"

if [ "${total}" -le "${KEEP}" ]; then
  if [ "${JSON_MODE}" = true ]; then
    printf '{\n'
    printf '  "snapshot_dir": "%s",\n' "$(json_escape "${SNAPSHOT_DIR}")"
    printf '  "keep": %s,\n' "${KEEP}"
    printf '  "total_before": %s,\n' "${total}"
    printf '  "removed": 0,\n'
    printf '  "dry_run": %s\n' "$( [ "${DRY_RUN}" = true ] && printf 'true' || printf 'false' )"
    printf '}\n'
  else
    echo "Nothing to prune (total=${total}, keep=${KEEP})"
  fi
  exit 0
fi

to_remove="$(printf '%s\n' "${json_files}" | sed '1,'"${KEEP}"'d')"
removed=0

while IFS= read -r json_file; do
  [ -z "${json_file}" ] && continue
  txt_file="${json_file%.json}.txt"
  if [ "${DRY_RUN}" = true ]; then
    :
  else
    rm -f "${json_file}" "${txt_file}"
  fi
  removed=$((removed + 1))
done <<EOF
${to_remove}
EOF

if [ "${JSON_MODE}" = true ]; then
  printf '{\n'
  printf '  "snapshot_dir": "%s",\n' "$(json_escape "${SNAPSHOT_DIR}")"
  printf '  "keep": %s,\n' "${KEEP}"
  printf '  "total_before": %s,\n' "${total}"
  printf '  "removed": %s,\n' "${removed}"
  printf '  "dry_run": %s\n' "$( [ "${DRY_RUN}" = true ] && printf 'true' || printf 'false' )"
  printf '}\n'
else
  echo "Pruned snapshots: removed=${removed}, keep=${KEEP}, total_before=${total}"
  if [ "${DRY_RUN}" = true ]; then
    echo "DRY-RUN: no files deleted"
  fi
fi
