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
  ./scripts/privacy-next-step.sh [--json]

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
sprint6="$(readiness_field "- Sprint 6 status")"
blockers="$(readiness_field "- Remaining blockers (snapshot)")"
live_report="$(readiness_field "- Live report exists")"
summary_exists="$(readiness_field "- RC summary exists")"

STATE="needs_provider_run"
ACTION_1="./scripts/prepare-privacy-fastmail-env.sh ./.env.fastmail.local"
ACTION_2="./scripts/run-privacy-fastmail-assist.sh ./.env.fastmail.local"
ACTION_3="./scripts/run-privacy-rc-postrun.sh --apply"
ACTION_4="./scripts/show-privacy-rc-readiness.sh --strict"

if [ "${decision}" = "GO" ] && [ "${sprint6}" = "DONE" ]; then
  STATE="closed"
  ACTION_1="./scripts/run-privacy-stability.sh --strict-rc"
  ACTION_2=""
  ACTION_3=""
  ACTION_4=""
elif [ "${live_report}" = "yes" ] && [ "${summary_exists}" = "yes" ]; then
  STATE="artifacts_ready"
  ACTION_1="./scripts/run-privacy-rc-postrun.sh --apply"
  ACTION_2="./scripts/show-privacy-rc-readiness.sh --strict"
  ACTION_3=""
  ACTION_4=""
fi

if [ "${JSON_MODE}" = true ]; then
  printf '{\n'
  printf '  "state": "%s",\n' "$(json_escape "${STATE}")"
  printf '  "decision": "%s",\n' "$(json_escape "${decision:-unknown}")"
  printf '  "sprint_6_status": "%s",\n' "$(json_escape "${sprint6:-unknown}")"
  printf '  "blockers": "%s",\n' "$(json_escape "${blockers:-unknown}")"
  printf '  "live_report_exists": "%s",\n' "$(json_escape "${live_report:-unknown}")"
  printf '  "rc_summary_exists": "%s",\n' "$(json_escape "${summary_exists:-unknown}")"
  printf '  "actions": [\n'
  printed=0
  for action in "${ACTION_1}" "${ACTION_2}" "${ACTION_3}" "${ACTION_4}"; do
    if [ -n "${action}" ]; then
      if [ "${printed}" -gt 0 ]; then
        printf ',\n'
      fi
      printf '    "%s"' "$(json_escape "${action}")"
      printed=$((printed + 1))
    fi
  done
  printf '\n  ]\n'
  printf '}\n'
  exit 0
fi

echo "Privacy Next Step"
echo
echo "Current state:"
echo "- decision: ${decision:-unknown}"
echo "- sprint 6: ${sprint6:-unknown}"
echo "- blockers: ${blockers:-unknown}"
echo "- live report: ${live_report:-unknown}"
echo "- rc summary: ${summary_exists:-unknown}"
echo

if [ "${STATE}" = "closed" ]; then
  cat <<'EOF'
Suggested next move:
- Sprint 6 is closed. Continue with Sprint 7 local plan and keep running:
  ./scripts/run-privacy-stability.sh --strict-rc
EOF
  exit 0
fi

if [ "${STATE}" = "artifacts_ready" ]; then
  cat <<'EOF'
Suggested next move:
- Artifacts are available. Apply RC post-run synchronization:
  ./scripts/run-privacy-rc-postrun.sh --apply
- Re-check readiness:
  ./scripts/show-privacy-rc-readiness.sh --strict
EOF
  exit 0
fi

cat <<'EOF'
Suggested next move:
- Complete provider-backed live run first:
  ./scripts/prepare-privacy-fastmail-env.sh ./.env.fastmail.local
  ./scripts/run-privacy-fastmail-assist.sh ./.env.fastmail.local
- Then regenerate and apply RC post-run docs:
  ./scripts/run-privacy-rc-postrun.sh --apply
  ./scripts/show-privacy-rc-readiness.sh --strict
EOF
