#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)"
LAST_RUN_PATH="${ROOT_DIR}/artifacts/last-run-path.txt"

SUMMARY_PATH="${1:-}"
OUTPUT_DIR="${2:-}"

if [ -z "${SUMMARY_PATH}" ]; then
  if [ -f "${LAST_RUN_PATH}" ]; then
    SUMMARY_PATH="$(cat "${LAST_RUN_PATH}")/rc-update-summary.md"
  else
    echo "FAIL: summary path is required when no last-run marker exists"
    echo "Usage: $0 <rc-update-summary-path> [output-dir]"
    exit 1
  fi
fi

if [ ! -f "${SUMMARY_PATH}" ]; then
  echo "FAIL: summary file not found: ${SUMMARY_PATH}"
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "FAIL: python3 is required for RC draft generation"
  exit 1
fi

if [ -z "${OUTPUT_DIR}" ]; then
  OUTPUT_DIR="$(dirname "${SUMMARY_PATH}")"
fi

mkdir -p "${OUTPUT_DIR}"

python3 - "${SUMMARY_PATH}" "${ROOT_DIR}" "${OUTPUT_DIR}" <<'PY'
import re
import sys
from pathlib import Path

summary_path = Path(sys.argv[1])
root_dir = Path(sys.argv[2])
output_dir = Path(sys.argv[3])

rc_snapshot_path = root_dir / "RC-CHECKLIST-SNAPSHOT.md"
current_status_path = root_dir / "CURRENT-STATUS.md"
rc_memo_path = root_dir / "RC-DECISION-MEMO.md"
release_track_path = root_dir / "RELEASE-TRACK-MEMO.md"

summary = summary_path.read_text(encoding="utf-8")
rc_snapshot = rc_snapshot_path.read_text(encoding="utf-8")
current_status = current_status_path.read_text(encoding="utf-8")
rc_memo = rc_memo_path.read_text(encoding="utf-8")
release_track = release_track_path.read_text(encoding="utf-8")

decision_match = re.search(r"- Proposed decision:\s+`(GO|NO-GO)`", summary)
if not decision_match:
    raise SystemExit("FAIL: unable to parse proposed decision from summary")
decision = decision_match.group(1)

blockers = re.findall(r"- `([^`]+)` requires follow-up before GO\.", summary)
if blockers == ["none"]:
    blockers = []

label_map = {
    "native_submission_relay": "native submission relay verification is not PASS in provider-backed run",
    "inbound_imap": "inbound IMAP verification is not PASS in provider-backed run",
    "restart_persistence": "restart persistence verification is not PASS",
    "incremental_sync": "incremental sync verification is not PASS",
    "privacy_read_models": "privacy-first read-model verification is not PASS",
    "overall_live_verification": "overall live verification is not PASS",
}

def replace_or_fail(pattern, replacement, name, *, text, flags=0):
    updated, count = re.subn(pattern, replacement, text, flags=flags)
    if count == 0:
        raise SystemExit(f"FAIL: unable to update {name}")
    return updated

if decision == "GO":
    rc_blockers_line = "none"
    remaining_lines = ["- none"]
    next_move = (
        "Lock RC artifacts, mark Sprint 6 as DONE, and proceed with candidate freeze controls."
    )
    blocker_lines = []
else:
    if blockers:
        rc_blockers_line = "; ".join(label_map.get(item, item) for item in blockers)
        remaining_lines = [f"- {label_map.get(item, item)}" for item in blockers]
        blocker_lines = [label_map.get(item, item) for item in blockers]
    else:
        rc_blockers_line = "provider-backed verification evidence is incomplete"
        remaining_lines = ["- provider-backed verification evidence is incomplete"]
        blocker_lines = ["provider-backed verification evidence is incomplete"]
    next_move = (
        "Resolve listed blockers, rerun provider-backed verification, and regenerate RC summary."
    )

rc_snapshot = replace_or_fail(
    r"(?m)^- decision: `[^`]+`$",
    f"- decision: `{decision}`",
    "RC-CHECKLIST-SNAPSHOT decision line",
    text=rc_snapshot,
)
rc_snapshot = replace_or_fail(
    r"(?m)^- remaining release blockers: `[^`]+`$",
    f"- remaining release blockers: `{rc_blockers_line}`",
    "RC-CHECKLIST-SNAPSHOT blockers line",
    text=rc_snapshot,
)

remaining_section = "## Remaining\n\n" + "\n".join(remaining_lines) + "\n\n"
rc_snapshot = replace_or_fail(
    r"## Remaining\n\n.*?\n## Go Condition",
    remaining_section + "## Go Condition",
    "RC-CHECKLIST-SNAPSHOT remaining section",
    text=rc_snapshot,
    flags=re.S,
)
rc_snapshot = replace_or_fail(
    r"## Recommended Next Move\n\n.*$",
    "## Recommended Next Move\n\n" + next_move + "\n",
    "RC-CHECKLIST-SNAPSHOT next move",
    text=rc_snapshot,
    flags=re.S,
)

current_status = replace_or_fail(
    r"(?m)^- `Sprint 6`: `[^`]+`, .*$",
    "- `Sprint 6`: `DONE`, closure checklist passed"
    if decision == "GO"
    else "- `Sprint 6`: `IN PROGRESS`, closure checklist active",
    "CURRENT-STATUS sprint 6 line",
    text=current_status,
)
current_status = replace_or_fail(
    r"(?m)^- release candidate: `[^`]+`$",
    f"- release candidate: `{decision}`",
    "CURRENT-STATUS release candidate line",
    text=current_status,
)

if decision == "GO":
    why_block = (
        "Why now `GO`:\n\n"
        "- first provider-backed verification completed with required gates PASS\n"
        "- live evidence and RC artifacts are synchronized\n"
        "- Sprint 6 closure gates are satisfied\n\n"
    )
    current_status = replace_or_fail(
        r"Why still `NO-GO`:\n\n.*?\n## Remaining Work Estimate\n\n",
        why_block + "## Remaining Work Estimate\n\n",
        "CURRENT-STATUS why block (GO)",
        text=current_status,
        flags=re.S,
    )
    current_status = replace_or_fail(
        r"(?m)^- to first strong release candidate: about `[^`]+`$",
        "- to first strong release candidate: about `0%` to `5%`",
        "CURRENT-STATUS remaining estimate line",
        text=current_status,
    )
else:
    why_lines = "\n".join(f"- {item}" for item in blocker_lines)
    why_block = f"Why still `NO-GO`:\n\n{why_lines}\n\n"
    current_status = replace_or_fail(
        r"Why (still `NO-GO`|now `GO`):\n\n.*?\n## Remaining Work Estimate\n\n",
        why_block + "## Remaining Work Estimate\n\n",
        "CURRENT-STATUS why block (NO-GO)",
        text=current_status,
        flags=re.S,
    )

rc_memo = replace_or_fail(
    r"(?m)^Current decision: `[^`]+`$",
    f"Current decision: `{decision}`",
    "RC-DECISION-MEMO current decision line",
    text=rc_memo,
)

if decision == "GO":
    memo_reason = (
        "Reason:\n\n"
        "- the local MVP core has passed\n"
        "- the API contract is frozen\n"
        "- the real provider-backed verification gates passed with recorded evidence\n\n"
        "This is not a product-scope problem.\n"
        "It is a release-verification problem.\n"
    )
    memo_next = (
        "Proceed with release candidate freeze operations and track only post-MVP follow-up work."
    )
else:
    blocker_reason_lines = "\n".join(f"- {item}" for item in blocker_lines)
    memo_reason = (
        "Reason:\n\n"
        "- the local MVP core has passed\n"
        "- the API contract is frozen\n"
        f"{blocker_reason_lines}\n\n"
        "This is not a product-scope problem.\n"
        "It is a release-verification problem.\n"
    )
    memo_next = (
        "Proceed directly to the next provider-backed verification pass and refresh the existing live verification report artifacts from that run."
    )

rc_memo = replace_or_fail(
    r"Reason:\n\n.*?\n\nThis is not a product-scope problem\.\nIt is a release-verification problem\.\n",
    memo_reason,
    "RC-DECISION-MEMO reason block",
    text=rc_memo,
    flags=re.S,
)
rc_memo = replace_or_fail(
    r"## Recommended Next Step\n\n.*$",
    "## Recommended Next Step\n\n" + memo_next + "\n",
    "RC-DECISION-MEMO next step",
    text=rc_memo,
    flags=re.S,
)

if decision == "GO":
    release_judgment = (
        "The service has completed provider-backed verification gates and now supports a `GO` release-candidate decision."
    )
    release_call = "release call: `GO` based on provider-backed evidence"
    block_intro = "No blocking item remains for the first RC from the provider-backed verification track."
    block_list = "- all required provider-backed gates recorded as `PASS` in the live report chain"
    readiness = "provider-backed verification readiness: `PASS`"
    why_header = "## Why `GO` Is Correct"
    why_body = (
        "`GO` here is based on real provider-backed evidence, not local-only confidence.\n\n"
        "The release boundary stayed disciplined and now has the missing proof."
    )
    next_action = (
        "The next best step is:\n\n"
        "1. lock the RC decision artifacts\n"
        "2. continue with freeze/release operations\n"
        "3. track remaining work as post-MVP follow-up, not RC blockers"
    )
else:
    release_judgment = (
        "The service is in a strong local pre-release state, but still correctly remains `NO-GO` for the first release candidate."
    )
    release_call = "release call: still blocked by provider-backed verification gaps"
    block_intro = "The remaining blockers are:"
    block_list = "\n".join(f"- {item}" for item in blocker_lines)
    readiness = "provider-backed verification readiness: `PREPARED`, blocked by unresolved gates"
    why_header = "## Why `NO-GO` Is Still Correct"
    why_body = (
        "`NO-GO` here is not a sign of weak implementation.\n\n"
        "It means the release process is correctly rejecting incomplete provider-backed evidence."
    )
    next_action = (
        "The next best step is still:\n\n"
        "1. rerun provider-backed verification for unresolved gates\n"
        "2. refresh live evidence and RC artifacts\n"
        "3. re-evaluate the RC decision boundary"
    )

release_track = replace_or_fail(
    r"## Current Judgment\n\n.*?\n\nShort version:",
    "## Current Judgment\n\n" + release_judgment + "\n\nShort version:",
    "RELEASE-TRACK-MEMO current judgment block",
    text=release_track,
    flags=re.S,
)
release_track = replace_or_fail(
    r"(?m)^- release call: .*$",
    f"- {release_call}",
    "RELEASE-TRACK-MEMO release call line",
    text=release_track,
)
release_track = replace_or_fail(
    r"## What Still Blocks The First RC\n\n.*?\n\n## Release Position",
    "## What Still Blocks The First RC\n\n"
    + block_intro
    + "\n\n"
    + block_list
    + "\n\n## Release Position",
    "RELEASE-TRACK-MEMO blockers section",
    text=release_track,
    flags=re.S,
)
release_track = replace_or_fail(
    r"(?m)^- provider-backed verification readiness: .*$",
    f"- {readiness}",
    "RELEASE-TRACK-MEMO readiness line",
    text=release_track,
)
release_track = replace_or_fail(
    r"(?m)^- first RC decision: `[^`]+`$",
    f"- first RC decision: `{decision}`",
    "RELEASE-TRACK-MEMO first RC decision line",
    text=release_track,
)
release_track = replace_or_fail(
    r"## Why `[^`]+` Is (Still )?Correct\n\n.*?\n\n## Immediate Next Action",
    why_header + "\n\n" + why_body + "\n\n## Immediate Next Action",
    "RELEASE-TRACK-MEMO why section",
    text=release_track,
    flags=re.S,
)
release_track = replace_or_fail(
    r"## Immediate Next Action\n\n.*?\n\n## What Should Not Happen Next",
    "## Immediate Next Action\n\n" + next_action + "\n\n## What Should Not Happen Next",
    "RELEASE-TRACK-MEMO immediate next action",
    text=release_track,
    flags=re.S,
)

rc_out = output_dir / "rc-checklist-snapshot.next.md"
status_out = output_dir / "current-status.next.md"
memo_out = output_dir / "rc-decision-memo.next.md"
track_out = output_dir / "release-track-memo.next.md"
notes_out = output_dir / "rc-doc-sync-notes.md"

rc_out.write_text(rc_snapshot, encoding="utf-8")
status_out.write_text(current_status, encoding="utf-8")
memo_out.write_text(rc_memo, encoding="utf-8")
track_out.write_text(release_track, encoding="utf-8")

notes = []
notes.append("# RC Doc Sync Notes")
notes.append("")
notes.append(f"- decision: `{decision}`")
notes.append(f"- source summary: `{summary_path}`")
notes.append(f"- generated draft: `{rc_out}`")
notes.append(f"- generated draft: `{status_out}`")
notes.append(f"- generated draft: `{memo_out}`")
notes.append(f"- generated draft: `{track_out}`")
notes.append("")
notes.append("Apply manually after review:")
notes.append(f"1. copy `{rc_out}` -> `RC-CHECKLIST-SNAPSHOT.md`")
notes.append(f"2. copy `{status_out}` -> `CURRENT-STATUS.md`")
notes.append(f"3. copy `{memo_out}` -> `RC-DECISION-MEMO.md`")
notes.append(f"4. copy `{track_out}` -> `RELEASE-TRACK-MEMO.md`")
notes.append("")
if blockers:
    notes.append("Detected blockers:")
    for item in blockers:
        notes.append(f"- {label_map.get(item, item)}")
else:
    notes.append("Detected blockers: none")
notes.append("")

notes_out.write_text("\n".join(notes), encoding="utf-8")

print(f"WROTE: {rc_out}")
print(f"WROTE: {status_out}")
print(f"WROTE: {memo_out}")
print(f"WROTE: {track_out}")
print(f"WROTE: {notes_out}")
print(f"PROPOSED_DECISION={decision}")
PY

echo "PASS: RC doc sync drafts generated"
