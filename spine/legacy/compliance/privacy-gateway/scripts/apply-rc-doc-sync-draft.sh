#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)"
LAST_RUN_PATH="${ROOT_DIR}/artifacts/last-run-path.txt"

APPLY_MODE="${APPLY_MODE:-false}"
DRAFT_DIR=""

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
Usage:
  ./scripts/apply-rc-doc-sync-draft.sh [--apply] [draft-dir]

Default behavior:
  - dry-run only (prints what would be changed)

Apply behavior:
  - pass --apply (or APPLY_MODE=true)
  - creates backup copies first
  - applies:
    - rc-checklist-snapshot.next.md -> RC-CHECKLIST-SNAPSHOT.md
    - current-status.next.md -> CURRENT-STATUS.md
    - rc-decision-memo.next.md -> RC-DECISION-MEMO.md
    - release-track-memo.next.md -> RELEASE-TRACK-MEMO.md
EOF
  exit 0
fi

if [ "${1:-}" = "--apply" ]; then
  APPLY_MODE="true"
  shift
fi

DRAFT_DIR="${1:-}"
if [ -z "${DRAFT_DIR}" ]; then
  if [ -f "${LAST_RUN_PATH}" ]; then
    DRAFT_DIR="$(cat "${LAST_RUN_PATH}")"
  else
    echo "FAIL: draft dir is required when no last-run marker exists"
    echo "Usage: $0 [--apply] <draft-dir>"
    exit 1
  fi
fi

if [ ! -d "${DRAFT_DIR}" ]; then
  echo "FAIL: draft dir not found: ${DRAFT_DIR}"
  exit 1
fi

RC_DRAFT="${DRAFT_DIR}/rc-checklist-snapshot.next.md"
STATUS_DRAFT="${DRAFT_DIR}/current-status.next.md"
MEMO_DRAFT="${DRAFT_DIR}/rc-decision-memo.next.md"
TRACK_DRAFT="${DRAFT_DIR}/release-track-memo.next.md"
NOTES_FILE="${DRAFT_DIR}/rc-doc-sync-notes.md"

RC_TARGET="${ROOT_DIR}/RC-CHECKLIST-SNAPSHOT.md"
STATUS_TARGET="${ROOT_DIR}/CURRENT-STATUS.md"
MEMO_TARGET="${ROOT_DIR}/RC-DECISION-MEMO.md"
TRACK_TARGET="${ROOT_DIR}/RELEASE-TRACK-MEMO.md"

for file in "${RC_DRAFT}" "${STATUS_DRAFT}" "${MEMO_DRAFT}" "${TRACK_DRAFT}"; do
  if [ ! -f "${file}" ]; then
    echo "FAIL: required draft file missing: ${file}"
    exit 1
  fi
done

echo "Draft source: ${DRAFT_DIR}"
echo "Will update:"
echo "- ${RC_TARGET} <- ${RC_DRAFT}"
echo "- ${STATUS_TARGET} <- ${STATUS_DRAFT}"
echo "- ${MEMO_TARGET} <- ${MEMO_DRAFT}"
echo "- ${TRACK_TARGET} <- ${TRACK_DRAFT}"
if [ -f "${NOTES_FILE}" ]; then
  echo "- notes: ${NOTES_FILE}"
fi

if [ "${APPLY_MODE}" != "true" ]; then
  echo "DRY-RUN: no files changed"
  echo "Use --apply to execute with backups"
  exit 0
fi

BACKUP_DIR="${DRAFT_DIR}/rc-doc-backups-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "${BACKUP_DIR}"

cp "${RC_TARGET}" "${BACKUP_DIR}/RC-CHECKLIST-SNAPSHOT.md.bak"
cp "${STATUS_TARGET}" "${BACKUP_DIR}/CURRENT-STATUS.md.bak"
cp "${MEMO_TARGET}" "${BACKUP_DIR}/RC-DECISION-MEMO.md.bak"
cp "${TRACK_TARGET}" "${BACKUP_DIR}/RELEASE-TRACK-MEMO.md.bak"

cp "${RC_DRAFT}" "${RC_TARGET}"
cp "${STATUS_DRAFT}" "${STATUS_TARGET}"
cp "${MEMO_DRAFT}" "${MEMO_TARGET}"
cp "${TRACK_DRAFT}" "${TRACK_TARGET}"

echo "PASS: RC docs updated from draft files"
echo "Backups:"
echo "- ${BACKUP_DIR}/RC-CHECKLIST-SNAPSHOT.md.bak"
echo "- ${BACKUP_DIR}/CURRENT-STATUS.md.bak"
echo "- ${BACKUP_DIR}/RC-DECISION-MEMO.md.bak"
echo "- ${BACKUP_DIR}/RELEASE-TRACK-MEMO.md.bak"
