#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
# ML1.6 — seed demo data into Mail Lab.
# ════════════════════════════════════════════════════════════════════════
#
# Idempotent. Re-run safely: existing accounts are skipped (mail-lab-api
# returns 409 Conflict on duplicate, which we treat as already-present).
#
# Demo data:
#   operator@seznam.lab        (the operator's outreach mailbox)
#   prospect[1-5]@seznam.lab   (recipients for tests + dev workflows)
#
# All passwords: lab-demo-only

set -uo pipefail

DOMAIN=${DOMAIN:-seznam.lab}
PASSWORD=${SEED_PASSWORD:-lab-demo-only}

# Map domain to container name
CONTAINER_NAME="mail-lab-${DOMAIN%.*}"  # seznam.lab → mail-lab-seznam

# Verify docker container exists
if ! docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  echo "ERROR: docker container '$CONTAINER_NAME' not found" >&2
  echo "       Run 'bash scripts/mail-lab/up.sh' first." >&2
  exit 1
fi

# create_mailbox <address> — docker exec setup.sh email add
# The setup.sh script is idempotent: re-running for an existing account
# just returns (no duplicate creation).
create_mailbox() {
  local addr="$1"
  local output
  output=$(docker exec "$CONTAINER_NAME" \
    /usr/local/bin/setup.sh email add "$addr" "$PASSWORD" 2>&1)

  # setup.sh outputs "Successfully added email account." for new accounts,
  # and "Email account already exists." for existing ones (idempotent behavior).
  if echo "$output" | grep -qi "successfully added\|already exists"; then
    if echo "$output" | grep -qi "successfully added"; then
      echo "  + created $addr"
    else
      echo "  = exists  $addr (idempotent skip)"
    fi
  else
    echo "  ! failed  $addr" >&2
    echo "    output: $output" >&2
    return 1
  fi
}

echo "── Seeding $DOMAIN"
create_mailbox "operator@$DOMAIN"
for i in 1 2 3 4 5; do
  create_mailbox "prospect${i}@$DOMAIN"
done

echo "── Done. 6 accounts (1 operator + 5 prospects) on $DOMAIN."
