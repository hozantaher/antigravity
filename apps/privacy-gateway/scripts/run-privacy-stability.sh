#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
. "${SCRIPT_DIR}/_privacy-wrapper-lib.sh"

run_privacy_gateway_script "run-local-stability-check.sh" "$@"
