#!/usr/bin/env bash
#
# Validate that all required Fastmail environment variables are set
# and free of placeholder text before a live SMTP/IMAP run.
#
# Usage:
#   ./scripts/check-fastmail-env.sh [path/to/.env.fastmail.local]
#
# Exit codes:
#   0  All variables present and non-placeholder
#   1  One or more variables missing, empty, or still contain placeholder text

set -euo pipefail

ENV_FILE="${1:-.env.fastmail.local}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "FAIL: env file not found: $ENV_FILE"
  exit 1
fi

# Source the env file twice: forward references (e.g. ${FASTMAIL_GATEWAY_ADDRESS}
# used before its definition) resolve on the second pass.
set -a
set +u
# shellcheck disable=SC1090
source "$ENV_FILE"
source "$ENV_FILE"
set -u
set +a

REQUIRED_VARS=(
  ALIAS_DOMAIN
  FASTMAIL_GATEWAY_ADDRESS
  RECIPIENT_MAILBOX_ADDRESS
  SMTP_PASSWORD
  DATA_ENCRYPTION_KEY_B64
)

PLACEHOLDER_PATTERN="^REPLACE_"

errors=0

mask_value() {
  local val="$1"
  local len=${#val}
  if [[ $len -le 4 ]]; then
    echo "****"
  else
    echo "${val:0:2}***${val: -2}"
  fi
}

for var in "${REQUIRED_VARS[@]}"; do
  val="${!var:-}"

  if [[ -z "$val" ]]; then
    echo "FAIL: $var is empty or unset"
    errors=$((errors + 1))
  elif [[ "$val" =~ $PLACEHOLDER_PATTERN ]]; then
    echo "FAIL: $var still contains placeholder text"
    errors=$((errors + 1))
  else
    echo "PASS: $var = $(mask_value "$val")"
  fi
done

echo ""

if [[ $errors -gt 0 ]]; then
  echo "Result: $errors of ${#REQUIRED_VARS[@]} variable(s) failed validation."
  exit 1
fi

echo "Result: All ${#REQUIRED_VARS[@]} required variables are set."
exit 0
