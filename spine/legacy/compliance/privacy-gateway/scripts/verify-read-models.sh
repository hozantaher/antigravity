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
ALIAS_ID="${ALIAS_ID:-}"
SUBMISSION_ID="${SUBMISSION_ID:-}"
INBOX_ID="${INBOX_ID:-}"

AUTH_HEADER="Authorization: Bearer ${API_TOKEN}"
INTAKE_AUTH_HEADER=""
if [ -n "${INTAKE_API_TOKEN}" ]; then
  INTAKE_AUTH_HEADER="Authorization: Bearer ${INTAKE_API_TOKEN}"
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "FAIL: python3 is required for JSON validation"
  exit 1
fi

fetch_json() {
  path="$1"
  curl -fsS "${BASE_URL}${path}" -H "${AUTH_HEADER}"
}

fetch_intake_json() {
  path="$1"
  if [ -z "${INTAKE_AUTH_HEADER}" ]; then
    echo "FAIL: intake token is required for intake checks"
    exit 1
  fi
  curl -fsS "${BASE_URL}${path}" -H "${INTAKE_AUTH_HEADER}"
}

discover_alias_id() {
  json="$(fetch_json "/v1/channels")"
  CHANNEL_DISCOVERY_JSON="$json" python3 <<'PY'
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

discover_timeline_ids() {
  json="$(fetch_json "/v1/aliases/${ALIAS_ID}/timeline")"
  DISCOVERY_TIMELINE_JSON="$json" python3 <<'PY'
import json
import os

payload = json.loads(os.environ["DISCOVERY_TIMELINE_JSON"])
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

assert_channels() {
  json="$(fetch_json "/v1/channels")"
  CHANNELS_JSON="$json" python3 - "$ALIAS_ID" <<'PY'
import json
import os
import sys

alias_id = sys.argv[1]
payload = json.loads(os.environ["CHANNELS_JSON"])
channels = payload.get("channels")
if not isinstance(channels, list):
    raise SystemExit("FAIL: channels payload missing list")
matched = None
for item in channels:
    alias = item.get("alias") or {}
    if alias.get("id") == alias_id:
        matched = item
        break
if matched is None:
    raise SystemExit(f"FAIL: alias {alias_id} not found in channels feed")
print(
    "PASS: channels feed contains alias "
    f"{alias_id} "
    f"(submissions={matched.get('submission_count', 0)}, "
    f"inbox={matched.get('inbox_count', 0)}, "
    f"relay_attempts={matched.get('relay_attempt_count', 0)})"
)
PY
}

assert_alias_timeline() {
  json="$(fetch_json "/v1/aliases/${ALIAS_ID}/timeline")"
  ALIAS_TIMELINE_JSON="$json" python3 - "$ALIAS_ID" <<'PY'
import json
import os
import sys

alias_id = sys.argv[1]
payload = json.loads(os.environ["ALIAS_TIMELINE_JSON"])
alias = payload.get("alias") or {}
summary = payload.get("summary") or {}
if alias.get("id") != alias_id:
    raise SystemExit(f"FAIL: alias timeline returned {alias.get('id')} instead of {alias_id}")
for key in ("submissions", "inbox_messages", "relay_attempts", "audit_events"):
    if not isinstance(payload.get(key), list):
        raise SystemExit(f"FAIL: alias timeline missing {key} list")
print(
    "PASS: alias timeline readable "
    f"(submission_count={summary.get('submission_count', 0)}, "
    f"inbox_count={summary.get('inbox_count', 0)}, "
    f"relay_attempt_count={summary.get('relay_attempt_count', 0)})"
)
PY
}

assert_submission_timeline() {
  json="$(fetch_json "/v1/submissions/${SUBMISSION_ID}/timeline")"
  SUBMISSION_TIMELINE_JSON="$json" python3 - "$SUBMISSION_ID" <<'PY'
import json
import os
import sys

submission_id = sys.argv[1]
payload = json.loads(os.environ["SUBMISSION_TIMELINE_JSON"])
submission = payload.get("submission") or {}
summary = payload.get("summary") or {}
if submission.get("id") != submission_id:
    raise SystemExit(
        f"FAIL: submission timeline returned {submission.get('id')} instead of {submission_id}"
    )
for key in ("relay_attempts", "audit_events"):
    if not isinstance(payload.get(key), list):
        raise SystemExit(f"FAIL: submission timeline missing {key} list")
print(
    "PASS: submission timeline readable "
    f"(latest_status={summary.get('latest_status', '')}, "
    f"attempt_count={summary.get('attempt_count', 0)}, "
    f"audit_event_count={summary.get('audit_event_count', 0)})"
)
PY
}

assert_inbox_timeline() {
  json="$(fetch_json "/v1/messages/inbox/${INBOX_ID}/timeline")"
  INBOX_TIMELINE_JSON="$json" python3 - "$INBOX_ID" <<'PY'
import json
import os
import sys

inbox_id = sys.argv[1]
payload = json.loads(os.environ["INBOX_TIMELINE_JSON"])
message = payload.get("message") or {}
summary = payload.get("summary") or {}
if message.get("id") != inbox_id:
    raise SystemExit(f"FAIL: inbox timeline returned {message.get('id')} instead of {inbox_id}")
if not isinstance(payload.get("audit_events"), list):
    raise SystemExit("FAIL: inbox timeline missing audit_events list")
print(
    "PASS: inbox timeline readable "
    f"(latest_status={summary.get('latest_status', '')}, "
    f"attempt_count={summary.get('attempt_count', 0)}, "
    f"audit_event_count={summary.get('audit_event_count', 0)})"
)
PY
}

assert_intake_dashboard() {
  json="$(fetch_intake_json "/v1/intake/dashboard")"
  INTAKE_DASHBOARD_JSON="$json" python3 <<'PY'
import json
import os

payload = json.loads(os.environ["INTAKE_DASHBOARD_JSON"])
summary = payload.get("summary")
if not isinstance(summary, dict):
    raise SystemExit("FAIL: intake dashboard missing summary object")
for key in ("problem_submissions", "recent_submissions"):
    if not isinstance(payload.get(key), list):
        raise SystemExit(f"FAIL: intake dashboard missing {key} list")
print(
    "PASS: intake dashboard readable "
    f"(submission_count={summary.get('submission_count', 0)}, "
    f"problem_submission_count={summary.get('problem_submission_count', 0)})"
)
PY
}

assert_intake_queue() {
  json="$(fetch_intake_json "/v1/intake/queue")"
  INTAKE_QUEUE_JSON="$json" python3 <<'PY'
import json
import os

payload = json.loads(os.environ["INTAKE_QUEUE_JSON"])
summary = payload.get("summary")
if not isinstance(summary, dict):
    raise SystemExit("FAIL: intake queue missing summary object")
if not isinstance(payload.get("submissions"), list):
    raise SystemExit("FAIL: intake queue missing submissions list")
print(
    "PASS: intake queue readable "
    f"(submission_count={summary.get('submission_count', 0)}, "
    f"retryable_submission_count={summary.get('retryable_submission_count', 0)})"
)
PY
}

assert_intake_submission_detail() {
  json="$(fetch_intake_json "/v1/intake/submissions/${SUBMISSION_ID}")"
  INTAKE_SUBMISSION_JSON="$json" python3 - "$SUBMISSION_ID" <<'PY'
import json
import os
import sys

submission_id = sys.argv[1]
payload = json.loads(os.environ["INTAKE_SUBMISSION_JSON"])
if payload.get("id") != submission_id:
    raise SystemExit(
        f"FAIL: intake submission detail returned {payload.get('id')} instead of {submission_id}"
    )
print(
    "PASS: intake submission detail readable "
    f"(id={submission_id}, status={payload.get('status', '')})"
)
PY
}

assert_intake_submission_timeline() {
  json="$(fetch_intake_json "/v1/intake/submissions/${SUBMISSION_ID}/timeline")"
  INTAKE_SUBMISSION_TIMELINE_JSON="$json" python3 - "$SUBMISSION_ID" <<'PY'
import json
import os
import sys

submission_id = sys.argv[1]
payload = json.loads(os.environ["INTAKE_SUBMISSION_TIMELINE_JSON"])
submission = payload.get("submission") or {}
summary = payload.get("summary") or {}
if submission.get("id") != submission_id:
    raise SystemExit(
        f"FAIL: intake submission timeline returned {submission.get('id')} instead of {submission_id}"
    )
for key in ("relay_attempts", "audit_events"):
    if not isinstance(payload.get(key), list):
        raise SystemExit(f"FAIL: intake submission timeline missing {key} list")
print(
    "PASS: intake submission timeline readable "
    f"(latest_status={summary.get('latest_status', '')}, "
    f"attempt_count={summary.get('attempt_count', 0)})"
)
PY
}

echo "Running read-model verification against ${BASE_URL}"

if [ -z "${ALIAS_ID}" ]; then
  ALIAS_ID="$(discover_alias_id)"
  echo "INFO: auto-discovered ALIAS_ID=${ALIAS_ID}"
fi

if [ -z "${SUBMISSION_ID}" ] || [ -z "${INBOX_ID}" ]; then
  discovered_ids="$(discover_timeline_ids)"
  discovered_submission_id="$(printf '%s\n' "$discovered_ids" | sed -n '1p')"
  discovered_inbox_id="$(printf '%s\n' "$discovered_ids" | sed -n '2p')"
  if [ -z "${SUBMISSION_ID}" ] && [ -n "${discovered_submission_id}" ]; then
    SUBMISSION_ID="${discovered_submission_id}"
    echo "INFO: auto-discovered SUBMISSION_ID=${SUBMISSION_ID}"
  fi
  if [ -z "${INBOX_ID}" ] && [ -n "${discovered_inbox_id}" ]; then
    INBOX_ID="${discovered_inbox_id}"
    echo "INFO: auto-discovered INBOX_ID=${INBOX_ID}"
  fi
fi

assert_channels
assert_alias_timeline

if [ -n "${SUBMISSION_ID}" ]; then
  assert_submission_timeline
else
  echo "SKIP: submission timeline check (SUBMISSION_ID not provided)"
fi

if [ -n "${INBOX_ID}" ]; then
  assert_inbox_timeline
else
  echo "SKIP: inbox timeline check (INBOX_ID not provided)"
fi

if [ -n "${INTAKE_API_TOKEN}" ]; then
  assert_intake_dashboard
  assert_intake_queue
  if [ -n "${SUBMISSION_ID}" ]; then
    assert_intake_submission_detail
    assert_intake_submission_timeline
  else
    echo "SKIP: intake submission detail/timeline checks (SUBMISSION_ID not provided)"
  fi
else
  echo "SKIP: intake read-model checks (INTAKE_API_TOKEN not provided)"
fi

echo "PASS: read-model verification completed"
