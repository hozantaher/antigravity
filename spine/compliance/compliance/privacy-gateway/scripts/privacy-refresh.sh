#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
DEFAULT_DIR="/tmp/privacy-status-snapshots"
SNAPSHOT_DIR="${DEFAULT_DIR}"
SKIP_SELF_CHECK=true
JSON_MODE=false
PRUNE_KEEP=""
PRUNE_DRY_RUN=false

json_escape() {
  printf '%s' "${1:-}" \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

extract_json_string() {
  key="$1"
  json="$2"
  printf '%s\n' "${json}" | sed -n "s/.*\"${key}\": \"\\([^\"]*\\)\".*/\\1/p" | head -n 1
}

usage() {
  cat <<'EOF'
Usage:
  ./scripts/privacy-refresh.sh [snapshot-dir] [--with-self-check] [--json] [--prune-keep <n>] [--prune-dry-run]

Runs a full privacy status refresh:
  1) capture fresh status snapshots (text + json)
  2) compare two latest snapshots
  3) print suggested next step

Default behavior skips self-check for speed.
When --prune-keep is set, prune runs before capture.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --with-self-check)
      SKIP_SELF_CHECK=false
      ;;
    --json)
      JSON_MODE=true
      ;;
    --prune-keep)
      PRUNE_KEEP="${2:-}"
      shift
      ;;
    --prune-dry-run)
      PRUNE_DRY_RUN=true
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      if [ "${SNAPSHOT_DIR}" = "${DEFAULT_DIR}" ]; then
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

if [ -n "${PRUNE_KEEP}" ]; then
  case "${PRUNE_KEEP}" in
    ''|*[!0-9]*)
      echo "FAIL: --prune-keep must be a non-negative integer"
      exit 1
      ;;
  esac
fi

if [ "${JSON_MODE}" = true ]; then
  prune_json='null'
  if [ -n "${PRUNE_KEEP}" ]; then
    if [ "${PRUNE_DRY_RUN}" = true ]; then
      prune_json="$("${SCRIPT_DIR}/privacy-prune-snapshots.sh" "${SNAPSHOT_DIR}" --keep "${PRUNE_KEEP}" --dry-run --json)"
    else
      prune_json="$("${SCRIPT_DIR}/privacy-prune-snapshots.sh" "${SNAPSHOT_DIR}" --keep "${PRUNE_KEEP}" --json)"
    fi
  fi

  if [ "${SKIP_SELF_CHECK}" = true ]; then
    capture_json="$("${SCRIPT_DIR}/privacy-capture-status.sh" "${SNAPSHOT_DIR}" --skip-self-check --json)"
  else
    capture_json="$("${SCRIPT_DIR}/privacy-capture-status.sh" "${SNAPSHOT_DIR}" --json)"
  fi

  compare_json="$("${SCRIPT_DIR}/privacy-compare-snapshots.sh" "${SNAPSHOT_DIR}" --json)"
  next_json="$("${SCRIPT_DIR}/privacy-next-step.sh" --json)"

  wrote_text="$(extract_json_string "text_path" "${capture_json}")"
  wrote_json="$(extract_json_string "json_path" "${capture_json}")"

  printf '{\n'
  printf '  "snapshot_dir": "%s",\n' "$(json_escape "${SNAPSHOT_DIR}")"
  printf '  "capture": {\n'
  printf '    "text_path": "%s",\n' "$(json_escape "${wrote_text}")"
  printf '    "json_path": "%s"\n' "$(json_escape "${wrote_json}")"
  printf '  },\n'
  printf '  "prune": %s,\n' "${prune_json}"
  printf '  "comparison": %s,\n' "${compare_json}"
  printf '  "next_step": %s\n' "${next_json}"
  printf '}\n'
  exit 0
fi

if [ -n "${PRUNE_KEEP}" ]; then
  echo "STEP 1/4: prune old snapshots"
  if [ "${PRUNE_DRY_RUN}" = true ]; then
    "${SCRIPT_DIR}/privacy-prune-snapshots.sh" "${SNAPSHOT_DIR}" --keep "${PRUNE_KEEP}" --dry-run
  else
    "${SCRIPT_DIR}/privacy-prune-snapshots.sh" "${SNAPSHOT_DIR}" --keep "${PRUNE_KEEP}"
  fi
  echo
  echo "STEP 2/4: capture fresh privacy status snapshot"
else
  echo "STEP 1/3: capture fresh privacy status snapshot"
fi

if [ "${SKIP_SELF_CHECK}" = true ]; then
  "${SCRIPT_DIR}/privacy-capture-status.sh" "${SNAPSHOT_DIR}" --skip-self-check
else
  "${SCRIPT_DIR}/privacy-capture-status.sh" "${SNAPSHOT_DIR}"
fi

echo
if [ -n "${PRUNE_KEEP}" ]; then
  echo "STEP 3/4: compare latest snapshots"
else
  echo "STEP 2/3: compare latest snapshots"
fi
"${SCRIPT_DIR}/privacy-compare-snapshots.sh" "${SNAPSHOT_DIR}"

echo
if [ -n "${PRUNE_KEEP}" ]; then
  echo "STEP 4/4: suggested next step"
else
  echo "STEP 3/3: suggested next step"
fi
"${SCRIPT_DIR}/privacy-next-step.sh"
