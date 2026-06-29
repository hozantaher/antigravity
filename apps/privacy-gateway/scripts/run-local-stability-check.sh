#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SERVICE_DIR="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)"
SERVICES_DIR="$(CDPATH= cd -- "${SERVICE_DIR}/.." && pwd)"
ANTI_TRACE_DIR="${SERVICES_DIR}/anti-trace-relay"

STRICT_RC=false
SKIP_ANTI_TRACE=false
ARTIFACT_DIR=""

usage() {
  cat <<'EOF'
Usage:
  ./scripts/run-local-stability-check.sh [--strict-rc] [--skip-anti-trace] [--use-cache] [artifact-dir]

Runs local stability checks for active services:
  1) go test ./... (privacy-gateway)
  2) go test ./... (anti-trace-relay, unless skipped or missing)
  3) RC readiness snapshot (strict mode optional)

Options:
  --strict-rc        Require strict RC readiness checks to pass.
  --skip-anti-trace  Skip anti-trace-relay test suite.
  --use-cache        Use Go test cache (default runs with -count=1).
EOF
}

GO_TEST_ARGS="-count=1 ./..."

while [ "$#" -gt 0 ]; do
  case "$1" in
    --strict-rc)
      STRICT_RC=true
      ;;
    --skip-anti-trace)
      SKIP_ANTI_TRACE=true
      ;;
    --use-cache)
      GO_TEST_ARGS="./..."
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      if [ -z "${ARTIFACT_DIR}" ]; then
        ARTIFACT_DIR="$1"
      else
        echo "FAIL: unexpected extra argument: $1"
        usage
        exit 1
      fi
      ;;
  esac
  shift
done

echo "STEP 1/3: privacy-gateway tests"
(cd "${SERVICE_DIR}" && go test ${GO_TEST_ARGS})

if [ "${SKIP_ANTI_TRACE}" = true ]; then
  echo "STEP 2/3: anti-trace-relay tests skipped by flag"
elif [ -d "${ANTI_TRACE_DIR}" ]; then
  echo "STEP 2/3: anti-trace-relay tests"
  if ! (cd "${ANTI_TRACE_DIR}" && go test ${GO_TEST_ARGS}); then
    echo "FAIL: anti-trace-relay tests failed"
    echo "Hint: if this is sandbox port-bind restriction, rerun outside sandbox or use --skip-anti-trace."
    exit 1
  fi
else
  echo "STEP 2/3: anti-trace-relay tests skipped (service not found)"
fi

echo "STEP 3/3: RC readiness"
if [ "${STRICT_RC}" = true ]; then
  if [ -n "${ARTIFACT_DIR}" ]; then
    "${SCRIPT_DIR}/show-rc-readiness.sh" --strict "${ARTIFACT_DIR}"
  else
    "${SCRIPT_DIR}/show-rc-readiness.sh" --strict
  fi
else
  if [ -n "${ARTIFACT_DIR}" ]; then
    "${SCRIPT_DIR}/show-rc-readiness.sh" "${ARTIFACT_DIR}"
  else
    "${SCRIPT_DIR}/show-rc-readiness.sh"
  fi
fi

echo "PASS: local stability checks completed"
