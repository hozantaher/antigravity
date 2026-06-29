#!/bin/sh

set -eu

ARTIFACT_DIR="${1:-}"
OUTPUT_PATH="${2:-}"
PROVIDER="${PROVIDER:-Fastmail}"
OPERATOR_NAME="${OPERATOR_NAME:-TBD}"
ENVIRONMENT_NAME="${ENVIRONMENT_NAME:-TBD}"
SERVICE_VERSION="${SERVICE_VERSION:-TBD}"

if [ -z "${ARTIFACT_DIR}" ]; then
  echo "FAIL: artifact directory is required"
  echo "Usage: $0 <artifact-dir> [output-report-path]"
  exit 1
fi

if [ ! -d "${ARTIFACT_DIR}" ]; then
  echo "FAIL: artifact directory does not exist: ${ARTIFACT_DIR}"
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "FAIL: python3 is required for report bootstrapping"
  exit 1
fi

if [ -z "${OUTPUT_PATH}" ]; then
  OUTPUT_PATH="${ARTIFACT_DIR}/live-verification-report.md"
fi

METADATA_FILE="${ARTIFACT_DIR}/metadata.txt"
COLLECTED_AT="TBD"
BASE_URL="TBD"
ALIAS_ID="TBD"
SUBMISSION_ID=""
INBOX_ID=""

if [ -f "${METADATA_FILE}" ]; then
  # shellcheck disable=SC1090
  . "${METADATA_FILE}"
  COLLECTED_AT="${COLLECTED_AT:-TBD}"
  BASE_URL="${BASE_URL:-TBD}"
  ALIAS_ID="${ALIAS_ID:-TBD}"
  SUBMISSION_ID="${SUBMISSION_ID:-}"
  INBOX_ID="${INBOX_ID:-}"
fi

read_json_field() {
  file="$1"
  expression="$2"
  if [ ! -f "${file}" ]; then
    printf '%s' "TBD"
    return
  fi
  python3 - "${file}" "${expression}" <<'PY'
import json
import sys

path = sys.argv[1]
expression = sys.argv[2]
with open(path, "r", encoding="utf-8") as handle:
    payload = json.load(handle)

current = payload
for part in expression.split("."):
    if part.isdigit():
        idx = int(part)
        if not isinstance(current, list) or idx >= len(current):
            current = "TBD"
            break
        current = current[idx]
        continue
    if not isinstance(current, dict):
        current = "TBD"
        break
    current = current.get(part, "TBD")

if current in ("", None):
    current = "TBD"
print(current)
PY
}

ALIAS_EMAIL="$(read_json_field "${ARTIFACT_DIR}/alias-timeline.json" "alias.email")"
HEALTH_STATUS="$(read_json_field "${ARTIFACT_DIR}/healthz.json" "status")"
CHANNEL_COUNT="$(read_json_field "${ARTIFACT_DIR}/channels.json" "channels.0.alias.id")"
SUBMISSION_STATUS="$(read_json_field "${ARTIFACT_DIR}/submission.json" "status")"
if [ "${SUBMISSION_STATUS}" = "TBD" ]; then
  SUBMISSION_STATUS="$(read_json_field "${ARTIFACT_DIR}/submission-timeline.json" "summary.latest_status")"
fi
INBOX_TIMELINE_STATUS="$(read_json_field "${ARTIFACT_DIR}/inbox-timeline.json" "summary.latest_status")"
INTAKE_DASHBOARD_COUNT="$(read_json_field "${ARTIFACT_DIR}/intake-dashboard.json" "summary.submission_count")"
INTAKE_QUEUE_COUNT="$(read_json_field "${ARTIFACT_DIR}/intake-queue.json" "summary.submission_count")"
INTAKE_SUBMISSION_STATUS="$(read_json_field "${ARTIFACT_DIR}/intake-submission.json" "status")"
INTAKE_SUBMISSION_TIMELINE_STATUS="$(read_json_field "${ARTIFACT_DIR}/intake-submission-timeline.json" "summary.latest_status")"

cat > "${OUTPUT_PATH}" <<EOF
# Privacy Gateway ${PROVIDER} Live Verification Report

## Run Metadata

- Provider: \`${PROVIDER}\`
- Date: \`${COLLECTED_AT}\`
- Operator: \`${OPERATOR_NAME}\`
- Environment: \`${ENVIRONMENT_NAME}\`
- Service version or commit: \`${SERVICE_VERSION}\`

## Configuration Summary

- Base URL: \`${BASE_URL}\`
- Artifact directory: \`${ARTIFACT_DIR}\`
- Alias ID: \`${ALIAS_ID}\`
- Alias email: \`${ALIAS_EMAIL}\`
- Submission ID: \`${SUBMISSION_ID:-TBD}\`
- Inbox ID: \`${INBOX_ID:-TBD}\`

Sensitive values such as passwords and app tokens must not be pasted into this report.

## Results

### 1. Health Check

- observed status: \`${HEALTH_STATUS}\`
- evidence: [healthz.json](${ARTIFACT_DIR}/healthz.json)
- notes: \`TBD\`

### 2. Alias Flow

- alias created: \`${ALIAS_ID}\`
- alias listed after creation: \`TBD\`
- alias domain correct: \`TBD\`
- evidence: [aliases.json](${ARTIFACT_DIR}/aliases.json)
- notes: \`TBD\`

### 3. Native Submission Relay Verification

- submission create returned \`201\`: \`TBD\`
- submission relay action accepted: \`TBD\`
- submission status after relay: \`${SUBMISSION_STATUS}\`
- outbox recorded relayed message when expected: \`TBD\`
- real recipient mailbox received message: \`TBD\`
- sender/domain behavior acceptable: \`TBD\`
- evidence: [submissions.json](${ARTIFACT_DIR}/submissions.json), [submission.json](${ARTIFACT_DIR}/submission.json), [submission-timeline.json](${ARTIFACT_DIR}/submission-timeline.json), [outbox.json](${ARTIFACT_DIR}/outbox.json)
- notes: \`TBD\`

### 4. IMAP Plain-Text Verification

- sync API returned \`202\`: \`TBD\`
- inbox stored plain-text message: \`TBD\`
- normalized \`text_body\` acceptable: \`TBD\`
- IMAP cursor advanced: \`TBD\`
- evidence: [inbox.json](${ARTIFACT_DIR}/inbox.json)
- notes: \`TBD\`

### 5. IMAP Attachment Verification

- attachment message appeared in inbox: \`TBD\`
- text body excluded attachment payload: \`TBD\`
- attachment metadata present: \`TBD\`
- attachment policy outcome present: \`TBD\`
- result acceptable: \`TBD\`
- evidence: [inbox.json](${ARTIFACT_DIR}/inbox.json)
- notes: \`TBD\`

### 6. Restart Persistence Verification

- aliases survived restart: \`TBD\`
- outbox survived restart: \`TBD\`
- inbox survived restart: \`TBD\`
- encrypted state reopened successfully: \`TBD\`
- evidence: [aliases.json](${ARTIFACT_DIR}/aliases.json), [outbox.json](${ARTIFACT_DIR}/outbox.json), [inbox.json](${ARTIFACT_DIR}/inbox.json)
- notes: \`TBD\`

### 7. Incremental Sync Verification

- new message appeared after second sync: \`TBD\`
- old messages were not duplicated unexpectedly: \`TBD\`
- cursor advanced again: \`TBD\`
- notes: \`TBD\`

### 8. Privacy-First Read-Model Verification

- channels feed acceptable: \`$( [ "${CHANNEL_COUNT}" = "TBD" ] && printf 'TBD' || printf 'observed' )\`
- alias timeline acceptable: \`$( [ -f "${ARTIFACT_DIR}/alias-timeline.json" ] && printf 'observed' || printf 'TBD' )\`
- submission detail acceptable: \`$( [ -f "${ARTIFACT_DIR}/submission.json" ] && printf 'observed' || printf 'TBD' )\`
- submission timeline latest status: \`${SUBMISSION_STATUS}\`
- inbox timeline latest status: \`${INBOX_TIMELINE_STATUS}\`
- intake dashboard submission count: \`${INTAKE_DASHBOARD_COUNT}\`
- intake queue submission count: \`${INTAKE_QUEUE_COUNT}\`
- intake submission status: \`${INTAKE_SUBMISSION_STATUS}\`
- intake submission timeline latest status: \`${INTAKE_SUBMISSION_TIMELINE_STATUS}\`
- evidence:
  - [channels.json](${ARTIFACT_DIR}/channels.json)
  - [alias-timeline.json](${ARTIFACT_DIR}/alias-timeline.json)
  - [submission.json](${ARTIFACT_DIR}/submission.json)
  - [submissions.json](${ARTIFACT_DIR}/submissions.json)
  - [submission-timeline.json](${ARTIFACT_DIR}/submission-timeline.json)
  - [inbox-timeline.json](${ARTIFACT_DIR}/inbox-timeline.json)
  - [intake-dashboard.json](${ARTIFACT_DIR}/intake-dashboard.json)
  - [intake-queue.json](${ARTIFACT_DIR}/intake-queue.json)
  - [intake-submission.json](${ARTIFACT_DIR}/intake-submission.json)
  - [intake-submission-timeline.json](${ARTIFACT_DIR}/intake-submission-timeline.json)
- notes: \`TBD\`

## Evidence Collected

- [metadata.txt](${ARTIFACT_DIR}/metadata.txt)
- [healthz.json](${ARTIFACT_DIR}/healthz.json)
- [aliases.json](${ARTIFACT_DIR}/aliases.json)
- [submissions.json](${ARTIFACT_DIR}/submissions.json)
- [submission.json](${ARTIFACT_DIR}/submission.json)
- [outbox.json](${ARTIFACT_DIR}/outbox.json)
- [inbox.json](${ARTIFACT_DIR}/inbox.json)
- [channels.json](${ARTIFACT_DIR}/channels.json)
- [alias-timeline.json](${ARTIFACT_DIR}/alias-timeline.json)
- [submission-timeline.json](${ARTIFACT_DIR}/submission-timeline.json)
- [inbox-timeline.json](${ARTIFACT_DIR}/inbox-timeline.json)
- [intake-dashboard.json](${ARTIFACT_DIR}/intake-dashboard.json)
- [intake-queue.json](${ARTIFACT_DIR}/intake-queue.json)
- [intake-submission.json](${ARTIFACT_DIR}/intake-submission.json)
- [intake-submission-timeline.json](${ARTIFACT_DIR}/intake-submission-timeline.json)

## Issues Found

1. \`TBD\`
2. \`TBD\`
3. \`TBD\`

## Provider-Specific Caveats

- app password required instead of account password: \`TBD\`
- sender domain behavior versus \`ALIAS_DOMAIN\`: \`TBD\`
- any provider-specific quirks observed: \`TBD\`

## Overall Decision

- native submission relay verification: \`TBD\`
- inbound IMAP verification: \`TBD\`
- restart persistence: \`TBD\`
- incremental sync: \`TBD\`
- privacy-first read-model verification: \`TBD\`
- overall live verification: \`TBD\`

## Release Recommendation

Choose one:

- release candidate can be frozen now
- release candidate can be frozen after minor fixes
- do not freeze release candidate yet

Selected recommendation: \`TBD\`

## Follow-Up Actions

1. \`TBD\`
2. \`TBD\`
3. \`TBD\`
EOF

echo "WROTE: ${OUTPUT_PATH}"
echo "PASS: report bootstrap completed"
