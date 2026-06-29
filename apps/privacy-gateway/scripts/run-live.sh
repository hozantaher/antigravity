#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
export AUTO_STOP=true
bash scripts/fastmail-live-assist.sh "$@"
