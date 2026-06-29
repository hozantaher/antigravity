#!/usr/bin/env bash
# scripts/mail-lab/clear-inbox.sh — wrapper around clear-inbox.mjs (OP2.4).

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <mailbox> [--password X] [--confirm 'I-KNOW-THIS-WIPES-INBOX']" >&2
  echo "       $0 op@gmail.lab --password labpass --confirm 'I-KNOW-THIS-WIPES-INBOX'" >&2
  exit 3
fi

MAILBOX="$1"
shift

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

exec node "${REPO_ROOT}/scripts/operator-practice/clear-inbox.mjs" \
  --mailbox "${MAILBOX}" \
  --host "${LAB_IMAP_HOST:-localhost}" \
  --port "${LAB_IMAP_PORT:-25993}" \
  "$@"
