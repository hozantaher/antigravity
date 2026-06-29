#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
DEFAULT_DIR="/tmp/privacy-status-snapshots"
OUTPUT_DIR="${DEFAULT_DIR}"
SKIP_SELF_CHECK=false
JSON_MODE=false

json_escape() {
  printf '%s' "${1:-}" \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

usage() {
  cat <<'EOF'
Usage:
  ./scripts/privacy-capture-status.sh [output-dir] [--skip-self-check] [--json]

Writes timestamped privacy status snapshots:
  - privacy-status-<timestamp>.txt
  - privacy-status-<timestamp>.json
  - latest.txt
  - latest.json

Options:
  --json  Print machine-readable JSON output.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-self-check)
      SKIP_SELF_CHECK=true
      ;;
    --json)
      JSON_MODE=true
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      if [ "${OUTPUT_DIR}" = "${DEFAULT_DIR}" ]; then
        OUTPUT_DIR="$1"
      else
        echo "FAIL: unsupported extra argument: $1"
        usage
        exit 1
      fi
      ;;
  esac
  shift
done

mkdir -p "${OUTPUT_DIR}"

STAMP="$(date '+%Y%m%dT%H%M%S%z' | sed 's/+/_/; s/-/_/')"
TEXT_PATH="${OUTPUT_DIR}/privacy-status-${STAMP}.txt"
JSON_PATH="${OUTPUT_DIR}/privacy-status-${STAMP}.json"
LATEST_TEXT="${OUTPUT_DIR}/latest.txt"
LATEST_JSON="${OUTPUT_DIR}/latest.json"

STATUS_ARGS=""
if [ "${SKIP_SELF_CHECK}" = true ]; then
  STATUS_ARGS="--skip-self-check"
fi

if [ -n "${STATUS_ARGS}" ]; then
  "${SCRIPT_DIR}/privacy-status.sh" ${STATUS_ARGS} >"${TEXT_PATH}"
  "${SCRIPT_DIR}/privacy-status.sh" ${STATUS_ARGS} --json >"${JSON_PATH}"
else
  "${SCRIPT_DIR}/privacy-status.sh" >"${TEXT_PATH}"
  "${SCRIPT_DIR}/privacy-status.sh" --json >"${JSON_PATH}"
fi

cp "${TEXT_PATH}" "${LATEST_TEXT}"
cp "${JSON_PATH}" "${LATEST_JSON}"

if [ "${JSON_MODE}" = true ]; then
  printf '{\n'
  printf '  "snapshot_dir": "%s",\n' "$(json_escape "${OUTPUT_DIR}")"
  printf '  "text_path": "%s",\n' "$(json_escape "${TEXT_PATH}")"
  printf '  "json_path": "%s",\n' "$(json_escape "${JSON_PATH}")"
  printf '  "latest_text": "%s",\n' "$(json_escape "${LATEST_TEXT}")"
  printf '  "latest_json": "%s"\n' "$(json_escape "${LATEST_JSON}")"
  printf '}\n'
  exit 0
fi

echo "WROTE: ${TEXT_PATH}"
echo "WROTE: ${JSON_PATH}"
echo "WROTE: ${LATEST_TEXT}"
echo "WROTE: ${LATEST_JSON}"
echo "PASS: privacy status snapshot captured"
