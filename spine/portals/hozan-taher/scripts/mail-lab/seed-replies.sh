#!/usr/bin/env bash
# scripts/mail-lab/seed-replies.sh — thin wrapper around seed-replies.mjs.
#
# Operator-friendly entrypoint. The Node script does the actual IMAP APPEND
# work; this wrapper sets sane defaults for the lab and forwards extras.
#
# Usage:
#   bash scripts/mail-lab/seed-replies.sh <count> <mailbox> [--password X] [extras...]
#
# Examples:
#   bash scripts/mail-lab/seed-replies.sh 10 op@gmail.lab --password labpass
#   bash scripts/mail-lab/seed-replies.sh 25 prospect@seznam.lab --category interested
#   bash scripts/mail-lab/seed-replies.sh 5  test@outlook.lab  --dry-run

set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <count> <mailbox> [--password X] [--category Y] [--dry-run] ..." >&2
  exit 3
fi

COUNT="$1"
MAILBOX="$2"
shift 2

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Default IMAPS host:port — override with --host / --port for non-default lab.
exec node "${REPO_ROOT}/scripts/operator-practice/seed-replies.mjs" \
  --count "${COUNT}" \
  --mailbox "${MAILBOX}" \
  --host "${LAB_IMAP_HOST:-localhost}" \
  --port "${LAB_IMAP_PORT:-25993}" \
  "$@"
