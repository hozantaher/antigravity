#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
. "${SCRIPT_DIR}/_privacy-readiness-lib.sh"

JSON_MODE=false
if [ "${1:-}" = "--json" ]; then
  JSON_MODE=true
elif [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage:
  ./scripts/privacy-blockers.sh [--json]

Options:
  --json  Print machine-readable JSON output.
EOF
  exit 0
elif [ "$#" -gt 0 ]; then
  echo "FAIL: unsupported argument: $1"
  echo "Use --help for usage."
  exit 1
fi

load_readiness_output

decision="$(readiness_field "- RC-CHECKLIST-SNAPSHOT decision")"
blockers="$(readiness_field "- Remaining blockers (snapshot)")"

if [ "${JSON_MODE}" = true ]; then
  if [ -z "${blockers}" ] || [ "${blockers}" = "unknown" ]; then
    printf '{\n'
    printf '  "decision": "%s",\n' "$(json_escape "${decision:-unknown}")"
    printf '  "blockers": [],\n'
    printf '  "status": "unknown"\n'
    printf '}\n'
    exit 0
  fi

  if [ "${blockers}" = "none" ]; then
    printf '{\n'
    printf '  "decision": "%s",\n' "$(json_escape "${decision:-unknown}")"
    printf '  "blockers": [],\n'
    printf '  "status": "clear"\n'
    printf '}\n'
    exit 0
  fi

  printf '{\n'
  printf '  "decision": "%s",\n' "$(json_escape "${decision:-unknown}")"
  printf '  "status": "blocked",\n'
  printf '  "blockers": [\n'
  first=true
  while IFS= read -r line; do
    if [ "${first}" = true ]; then
      first=false
    else
      printf ',\n'
    fi
    printf '    "%s"' "$(json_escape "${line}")"
  done <<EOF
$(split_blockers_lines "${blockers}")
EOF
  printf '\n  ],\n'
  printf '  "workflow": [\n'
  printf '    "./scripts/run-privacy-fastmail-assist.sh ./.env.fastmail.local",\n'
  printf '    "./scripts/run-privacy-rc-postrun.sh --apply",\n'
  printf '    "./scripts/show-privacy-rc-readiness.sh --strict"\n'
  printf '  ]\n'
  printf '}\n'
  exit 0
fi

echo "Privacy Blockers"
echo
echo "Current decision: ${decision:-unknown}"
echo

if [ -z "${blockers}" ] || [ "${blockers}" = "unknown" ]; then
  echo "No blockers found in readiness output."
  exit 0
fi

if [ "${blockers}" = "none" ]; then
  echo "No remaining blockers."
  echo "Next: ./scripts/show-privacy-rc-readiness.sh --strict"
  exit 0
fi

echo "Remaining blockers:"
while IFS= read -r line; do
  echo "- ${line}"
done <<EOF
$(split_blockers_lines "${blockers}")
EOF
echo
cat <<'EOF'
Suggested blocker workflow:
1. Run provider-backed verification and capture artifacts:
   ./scripts/run-privacy-fastmail-assist.sh ./.env.fastmail.local
2. Apply RC post-run synchronization:
   ./scripts/run-privacy-rc-postrun.sh --apply
3. Validate strict readiness:
   ./scripts/show-privacy-rc-readiness.sh --strict
EOF
