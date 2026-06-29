#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${ENV_FILE:-}"

if [ -z "${ENV_FILE}" ]; then
  DEFAULT_ENV_FILE="${ROOT_DIR}/.env.fastmail.local"
  if [ -f "${DEFAULT_ENV_FILE}" ]; then
    ENV_FILE="${DEFAULT_ENV_FILE}"
  fi
fi

if [ -n "${ENV_FILE}" ]; then
  if [ ! -f "${ENV_FILE}" ]; then
    echo "FAIL: ENV_FILE does not exist: ${ENV_FILE}"
    exit 1
  fi
  set -a
  # shellcheck source=/dev/null
  . "${ENV_FILE}"
  set +a
  echo "INFO: loaded env from ${ENV_FILE}"
fi

BASE_URL="${BASE_URL:-http://localhost:8080}"
API_TOKEN="${API_TOKEN:-${DEV_API_TOKEN:-dev-token}}"
INTAKE_API_TOKEN="${INTAKE_API_TOKEN:-}"
OUTPUT_DIR="${OUTPUT_DIR:-./artifacts/live-verification-$(date -u +%Y%m%dT%H%M%SZ)}"
ALIAS_ID="${ALIAS_ID:-}"
SUBMISSION_ID="${SUBMISSION_ID:-}"
INBOX_ID="${INBOX_ID:-}"

AUTH_HEADER="Authorization: Bearer ${API_TOKEN}"
INTAKE_AUTH_HEADER=""
if [ -n "${INTAKE_API_TOKEN}" ]; then
  INTAKE_AUTH_HEADER="Authorization: Bearer ${INTAKE_API_TOKEN}"
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "FAIL: python3 is required for JSON discovery"
  exit 1
fi

mkdir -p "${OUTPUT_DIR}"

fetch_json() {
  path="$1"
  curl -fsS "${BASE_URL}${path}" -H "${AUTH_HEADER}"
}

fetch_intake_json() {
  path="$1"
  if [ -z "${INTAKE_AUTH_HEADER}" ]; then
    echo "FAIL: intake token is required for intake evidence collection"
    exit 1
  fi
  curl -fsS "${BASE_URL}${path}" -H "${INTAKE_AUTH_HEADER}"
}

write_json_file() {
  path="$1"
  target="$2"
  fetch_json "${path}" > "${target}"
  echo "WROTE: ${target}"
}

write_intake_json_file() {
  path="$1"
  target="$2"
  fetch_intake_json "${path}" > "${target}"
  echo "WROTE: ${target}"
}

discover_alias_id() {
  channels_json="$1"
  CHANNEL_DISCOVERY_JSON="$channels_json" python3 <<'PY'
import json
import os

payload = json.loads(os.environ["CHANNEL_DISCOVERY_JSON"])
channels = payload.get("channels")
if not isinstance(channels, list) or not channels:
    raise SystemExit("FAIL: no channels available for alias auto-discovery")

def sort_key(item):
    latest_activity = item.get("latest_activity_at") or ""
    alias = item.get("alias") or {}
    alias_id = alias.get("id") or ""
    return (latest_activity, alias_id)

selected = max(channels, key=sort_key)
alias = selected.get("alias") or {}
alias_id = alias.get("id")
if not alias_id:
    raise SystemExit("FAIL: selected channel is missing alias.id")
print(alias_id)
PY
}

discover_ids_from_alias_timeline() {
  alias_timeline_json="$1"
  ALIAS_TIMELINE_DISCOVERY_JSON="$alias_timeline_json" python3 <<'PY'
import json
import os

payload = json.loads(os.environ["ALIAS_TIMELINE_DISCOVERY_JSON"])
submissions = payload.get("submissions")
inbox_messages = payload.get("inbox_messages")
if not isinstance(submissions, list):
    raise SystemExit("FAIL: alias timeline missing submissions list")
if not isinstance(inbox_messages, list):
    raise SystemExit("FAIL: alias timeline missing inbox_messages list")

submission_id = ""
if submissions:
    latest_submission = max(submissions, key=lambda item: (item.get("created_at") or "", item.get("id") or ""))
    submission_id = latest_submission.get("id") or ""

inbox_id = ""
if inbox_messages:
    latest_inbox = max(inbox_messages, key=lambda item: (item.get("received_at") or "", item.get("id") or ""))
    inbox_id = latest_inbox.get("id") or ""

print(submission_id)
print(inbox_id)
PY
}

echo "Collecting live evidence into ${OUTPUT_DIR}"

write_json_file "/healthz" "${OUTPUT_DIR}/healthz.json"
write_json_file "/v1/aliases" "${OUTPUT_DIR}/aliases.json"
write_json_file "/v1/submissions" "${OUTPUT_DIR}/submissions.json"
write_json_file "/v1/messages/outbox" "${OUTPUT_DIR}/outbox.json"
write_json_file "/v1/messages/inbox" "${OUTPUT_DIR}/inbox.json"
channels_json="$(fetch_json "/v1/channels")"
printf '%s' "${channels_json}" > "${OUTPUT_DIR}/channels.json"
echo "WROTE: ${OUTPUT_DIR}/channels.json"

if [ -z "${ALIAS_ID}" ]; then
  ALIAS_ID="$(discover_alias_id "${channels_json}")"
  echo "INFO: auto-discovered ALIAS_ID=${ALIAS_ID}"
fi

alias_timeline_json="$(fetch_json "/v1/aliases/${ALIAS_ID}/timeline")"
printf '%s' "${alias_timeline_json}" > "${OUTPUT_DIR}/alias-timeline.json"
echo "WROTE: ${OUTPUT_DIR}/alias-timeline.json"

if [ -z "${SUBMISSION_ID}" ] || [ -z "${INBOX_ID}" ]; then
  discovered_ids="$(discover_ids_from_alias_timeline "${alias_timeline_json}")"
  discovered_submission_id="$(printf '%s\n' "${discovered_ids}" | sed -n '1p')"
  discovered_inbox_id="$(printf '%s\n' "${discovered_ids}" | sed -n '2p')"
  if [ -z "${SUBMISSION_ID}" ] && [ -n "${discovered_submission_id}" ]; then
    SUBMISSION_ID="${discovered_submission_id}"
    echo "INFO: auto-discovered SUBMISSION_ID=${SUBMISSION_ID}"
  fi
  if [ -z "${INBOX_ID}" ] && [ -n "${discovered_inbox_id}" ]; then
    INBOX_ID="${discovered_inbox_id}"
    echo "INFO: auto-discovered INBOX_ID=${INBOX_ID}"
  fi
fi

if [ -n "${SUBMISSION_ID}" ]; then
  write_json_file "/v1/submissions/${SUBMISSION_ID}" "${OUTPUT_DIR}/submission.json"
  write_json_file "/v1/submissions/${SUBMISSION_ID}/timeline" "${OUTPUT_DIR}/submission-timeline.json"
else
  echo "SKIP: submission detail/timeline not collected (no SUBMISSION_ID available)"
fi

if [ -n "${INBOX_ID}" ]; then
  write_json_file "/v1/messages/inbox/${INBOX_ID}/timeline" "${OUTPUT_DIR}/inbox-timeline.json"
else
  echo "SKIP: inbox timeline not collected (no INBOX_ID available)"
fi

if [ -n "${INTAKE_API_TOKEN}" ]; then
  write_intake_json_file "/v1/intake/dashboard" "${OUTPUT_DIR}/intake-dashboard.json"
  write_intake_json_file "/v1/intake/queue" "${OUTPUT_DIR}/intake-queue.json"
  if [ -n "${SUBMISSION_ID}" ]; then
    write_intake_json_file "/v1/intake/submissions/${SUBMISSION_ID}" "${OUTPUT_DIR}/intake-submission.json"
    write_intake_json_file "/v1/intake/submissions/${SUBMISSION_ID}/timeline" "${OUTPUT_DIR}/intake-submission-timeline.json"
  else
    echo "SKIP: intake submission detail/timeline not collected (no SUBMISSION_ID available)"
  fi
else
  echo "SKIP: intake evidence not collected (INTAKE_API_TOKEN not provided)"
fi

cat > "${OUTPUT_DIR}/metadata.txt" <<EOF
BASE_URL=${BASE_URL}
ALIAS_ID=${ALIAS_ID}
SUBMISSION_ID=${SUBMISSION_ID}
INBOX_ID=${INBOX_ID}
INTAKE_EVIDENCE_COLLECTED=$( [ -n "${INTAKE_API_TOKEN}" ] && printf 'true' || printf 'false' )
COLLECTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
echo "WROTE: ${OUTPUT_DIR}/metadata.txt"

echo "PASS: live evidence collection completed"
