#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ "$1" = "--vm" ]; then
    exec "${SCRIPT_DIR}/vm/launch.sh"
fi

SANDBOX_HOME="${SCRIPT_DIR}/sandboxed-home"
PROFILE="${SCRIPT_DIR}/claude-desktop.sb"

mkdir -p "${SANDBOX_HOME}/claude-data"

exec sandbox-exec -f "${PROFILE}" \
    /Applications/Claude.app/Contents/MacOS/Claude \
    --user-data-dir="${SANDBOX_HOME}/claude-data"
