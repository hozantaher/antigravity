#!/bin/sh

set -eu

ARTIFACT_DIR="${1:-}"
PID_FILE="${PID_FILE:-}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT_DIR="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)"
LAST_RUN_PATH="${ROOT_DIR}/artifacts/last-run-path.txt"
USED_LAST_RUN_PATH=false

if [ -z "${ARTIFACT_DIR}" ] && [ -z "${PID_FILE}" ]; then
  if [ -f "${LAST_RUN_PATH}" ]; then
    ARTIFACT_DIR="$(cat "${LAST_RUN_PATH}")"
    USED_LAST_RUN_PATH=true
    echo "INFO: using last run artifact dir ${ARTIFACT_DIR}"
  else
    echo "FAIL: provide either an artifact directory or PID_FILE"
    echo "Usage: $0 <artifact-dir>"
    echo "   or: PID_FILE=./artifacts/.../service.pid $0"
    exit 1
  fi
fi

if [ -z "${PID_FILE}" ]; then
  PID_FILE="${ARTIFACT_DIR}/service.pid"
fi

if [ ! -f "${PID_FILE}" ]; then
  echo "FAIL: PID file not found: ${PID_FILE}"
  exit 1
fi

if [ -z "${ARTIFACT_DIR}" ]; then
  ARTIFACT_DIR="$(dirname "${PID_FILE}")"
fi

PID="$(cat "${PID_FILE}")"

if [ -z "${PID}" ]; then
  echo "FAIL: PID file is empty: ${PID_FILE}"
  exit 1
fi

if ! kill -0 "${PID}" 2>/dev/null; then
  echo "INFO: process ${PID} is not running"
  rm -f "${PID_FILE}"
  if [ "${USED_LAST_RUN_PATH}" = true ]; then
    rm -f "${LAST_RUN_PATH}"
  fi
  exit 0
fi

kill "${PID}"

attempt=0
while [ "${attempt}" -lt 10 ]; do
  if ! kill -0 "${PID}" 2>/dev/null; then
    rm -f "${PID_FILE}"
    if [ "${USED_LAST_RUN_PATH}" = true ] || [ "${ARTIFACT_DIR}" = "$(cat "${LAST_RUN_PATH}" 2>/dev/null || printf '')" ]; then
      rm -f "${LAST_RUN_PATH}"
    fi
    echo "PASS: stopped process ${PID}"
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 1
done

echo "INFO: process ${PID} did not exit after TERM, sending KILL"
kill -9 "${PID}" 2>/dev/null || true
rm -f "${PID_FILE}"
if [ "${USED_LAST_RUN_PATH}" = true ] || [ "${ARTIFACT_DIR}" = "$(cat "${LAST_RUN_PATH}" 2>/dev/null || printf '')" ]; then
  rm -f "${LAST_RUN_PATH}"
fi
echo "PASS: stopped process ${PID}"
