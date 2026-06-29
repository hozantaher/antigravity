#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
HOOK_DIR="$ROOT/.githooks"
PRE_PUSH="$HOOK_DIR/pre-push"

if [[ ! -d "$HOOK_DIR" ]]; then
  echo "Hook directory missing: $HOOK_DIR"
  exit 1
fi

if [[ ! -f "$PRE_PUSH" ]]; then
  echo "Pre-push hook missing: $PRE_PUSH"
  exit 1
fi

chmod +x "$PRE_PUSH"
git config core.hooksPath .githooks

echo "Installed git hooks path: .githooks"
echo "Pre-push hook active: $PRE_PUSH"
echo "Tip: set IMPACT_WITH_E2E=1 to include Playwright in pre-push checks."
