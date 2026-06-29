#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)"
LAST_RUN_PATH="${ROOT_DIR}/artifacts/last-run-path.txt"

REPORT_PATH="${1:-}"
OUTPUT_PATH="${2:-}"

if [ -z "${REPORT_PATH}" ]; then
  if [ -f "${LAST_RUN_PATH}" ]; then
    REPORT_PATH="$(cat "${LAST_RUN_PATH}")/live-verification-report.md"
  else
    echo "FAIL: report path is required when no last-run marker exists"
    echo "Usage: $0 <live-report-path> [output-summary-path]"
    exit 1
  fi
fi

if [ ! -f "${REPORT_PATH}" ]; then
  echo "FAIL: report file not found: ${REPORT_PATH}"
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "FAIL: python3 is required for RC summary generation"
  exit 1
fi

if [ -z "${OUTPUT_PATH}" ]; then
  OUTPUT_PATH="$(dirname "${REPORT_PATH}")/rc-update-summary.md"
fi

python3 - "${REPORT_PATH}" "${OUTPUT_PATH}" <<'PY'
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

report_path = Path(sys.argv[1])
output_path = Path(sys.argv[2])
content = report_path.read_text(encoding="utf-8")

gate_patterns = {
    "native_submission_relay": r"-\s+native submission relay verification:\s+`([^`]+)`",
    "inbound_imap": r"-\s+inbound IMAP verification:\s+`([^`]+)`",
    "restart_persistence": r"-\s+restart persistence:\s+`([^`]+)`",
    "incremental_sync": r"-\s+incremental sync:\s+`([^`]+)`",
    "privacy_read_models": r"-\s+privacy-first read-model verification:\s+`([^`]+)`",
    "overall_live_verification": r"-\s+overall live verification:\s+`([^`]+)`",
}

results = {}
for key, pattern in gate_patterns.items():
    match = re.search(pattern, content, re.IGNORECASE)
    value = (match.group(1).strip() if match else "MISSING").upper()
    if value not in {"PASS", "FAIL", "MISSING"}:
        value = "INVALID"
    results[key] = value

required_keys = [
    "native_submission_relay",
    "inbound_imap",
    "privacy_read_models",
    "overall_live_verification",
]

all_required_pass = all(results[k] == "PASS" for k in required_keys)
any_fail = any(v == "FAIL" for v in results.values())
has_missing = any(v == "MISSING" for v in results.values())
has_invalid = any(v == "INVALID" for v in results.values())

if all_required_pass and not any_fail and not has_missing and not has_invalid:
    decision = "GO"
    rationale = "All required live verification gates are PASS."
else:
    decision = "NO-GO"
    if has_missing:
        rationale = "Some decision fields are missing in the live report."
    elif has_invalid:
        rationale = "Some decision fields have invalid values (expected PASS or FAIL)."
    elif any_fail:
        rationale = "At least one live verification gate is FAIL."
    else:
        rationale = "Required gates are not fully PASS."

failed_or_missing = [
    key for key, value in results.items() if value in {"FAIL", "MISSING", "INVALID"}
]

timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

lines = []
lines.append("# RC Update Summary")
lines.append("")
lines.append(f"- Generated at: `{timestamp}`")
lines.append(f"- Source report: `{report_path}`")
lines.append(f"- Proposed decision: `{decision}`")
lines.append(f"- Rationale: {rationale}")
lines.append("")
lines.append("## Gate Results")
for key in gate_patterns.keys():
    lines.append(f"- {key}: `{results[key]}`")
lines.append("")
lines.append("## Required Doc Updates")
lines.append("- Update `RC-CHECKLIST-SNAPSHOT.md` decision and remaining blockers.")
lines.append("- Update `RC-DECISION-MEMO.md` only if decision changed.")
lines.append("- Align `CURRENT-STATUS.md` release position and Sprint 6 status.")
lines.append("- Align `RELEASE-TRACK-MEMO.md` short judgment.")
lines.append("")
lines.append("## Blocking Items")
if failed_or_missing:
    for item in failed_or_missing:
        lines.append(f"- `{item}` requires follow-up before GO.")
else:
    lines.append("- none")
lines.append("")
lines.append("## Next Action")
if decision == "GO":
    lines.append(
        "- Apply `RC-POST-RUN-UPDATE-CHECKLIST.md`, set RC docs to GO, and close Sprint 6."
    )
else:
    lines.append(
        "- Keep RC as NO-GO, document blockers in the live report, and rerun provider verification as needed."
    )
lines.append("")

output_path.write_text("\n".join(lines), encoding="utf-8")
print(f"WROTE: {output_path}")
print(f"PROPOSED_DECISION={decision}")
PY

echo "PASS: RC update summary generated"
