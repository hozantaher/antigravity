#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
. "${SCRIPT_DIR}/_privacy-readiness-lib.sh"
RUN_SELF_CHECK=true
JSON_MODE=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-self-check)
      RUN_SELF_CHECK=false
      ;;
    --json)
      JSON_MODE=true
      ;;
    --help|-h)
  cat <<'EOF'
Usage:
  ./scripts/privacy-status.sh [--skip-self-check] [--json]

Options:
  --skip-self-check   Skip running privacy-self-check.sh before readiness output.
  --json              Print machine-readable JSON output.
EOF
      exit 0
      ;;
    *)
      echo "FAIL: unsupported argument: $1"
      echo "Use --help for usage."
      exit 1
      ;;
  esac
  shift
done

if [ "${JSON_MODE}" = true ]; then
  self_check_status="skipped"
  if [ "${RUN_SELF_CHECK}" = true ]; then
    if "${SCRIPT_DIR}/privacy-self-check.sh" >/dev/null; then
      self_check_status="pass"
    else
      self_check_status="fail"
    fi
  fi

  load_readiness_output
  snapshot_decision="$(readiness_field "- RC-CHECKLIST-SNAPSHOT decision")"
  memo_decision="$(readiness_field "- RC-DECISION-MEMO decision")"
  status_decision="$(readiness_field "- CURRENT-STATUS decision")"
  track_decision="$(readiness_field "- RELEASE-TRACK-MEMO decision")"
  sprint6_status="$(readiness_field "- Sprint 6 status")"
  blockers_line="$(readiness_field "- Remaining blockers (snapshot)")"
  artifact_dir="$(readiness_field "- Artifact dir")"
  live_report_exists="$(readiness_field "- Live report exists")"
  rc_summary_exists="$(readiness_field "- RC summary exists")"

  blockers_json="$("${SCRIPT_DIR}/privacy-blockers.sh" --json)"
  next_step_json="$("${SCRIPT_DIR}/privacy-next-step.sh" --json)"

  printf '{\n'
  printf '  "generated_at": "%s",\n' "$(json_escape "$(date '+%Y-%m-%d %H:%M:%S %z')")"
  printf '  "self_check": "%s",\n' "$(json_escape "${self_check_status}")"
  printf '  "readiness": {\n'
  printf '    "snapshot_decision": "%s",\n' "$(json_escape "${snapshot_decision:-unknown}")"
  printf '    "memo_decision": "%s",\n' "$(json_escape "${memo_decision:-unknown}")"
  printf '    "current_status_decision": "%s",\n' "$(json_escape "${status_decision:-unknown}")"
  printf '    "release_track_decision": "%s",\n' "$(json_escape "${track_decision:-unknown}")"
  printf '    "sprint_6_status": "%s",\n' "$(json_escape "${sprint6_status:-unknown}")"
  printf '    "blockers": "%s",\n' "$(json_escape "${blockers_line:-unknown}")"
  printf '    "artifact_dir": "%s",\n' "$(json_escape "${artifact_dir:-unknown}")"
  printf '    "live_report_exists": "%s",\n' "$(json_escape "${live_report_exists:-unknown}")"
  printf '    "rc_summary_exists": "%s"\n' "$(json_escape "${rc_summary_exists:-unknown}")"
  printf '  },\n'
  printf '  "blocker_details": %s,\n' "${blockers_json}"
  printf '  "next_step": %s\n' "${next_step_json}"
  printf '}\n'
  exit 0
fi

echo "Privacy Status"
echo "Generated: $(date '+%Y-%m-%d %H:%M:%S %z')"
echo

if [ "${RUN_SELF_CHECK}" = true ]; then
  echo "== Tooling Self Check =="
  "${SCRIPT_DIR}/privacy-self-check.sh"
  echo
fi

echo "== RC Readiness Snapshot =="
"${SCRIPT_DIR}/show-privacy-rc-readiness.sh"
echo

echo "== Remaining Blockers =="
"${SCRIPT_DIR}/privacy-blockers.sh"
echo

echo "== Suggested Next Step =="
"${SCRIPT_DIR}/privacy-next-step.sh"
