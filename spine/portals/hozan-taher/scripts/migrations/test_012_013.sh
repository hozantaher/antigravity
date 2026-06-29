#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
# Brutal test for migrations 012 + 013 (mail-client-fidelity S1.1).
# ════════════════════════════════════════════════════════════════════════
#
# 21 assertions on schema correctness + behavior + constraints + cascade.
#
# Requires DATABASE_URL_TEST pointing at a Postgres where this script can
# create + drop a transient database (`mig_test_<rand>`). Skips with exit 0
# if not set so CI without a DB silently passes.
#
# Example:
#   docker exec -e PGPASSWORD=kancelar_dev kancelar-postgres \
#     psql -U kancelar -d postgres -c "..."
#   DATABASE_URL_TEST="postgresql://kancelar:kancelar_dev@127.0.0.1:4102/postgres" \
#     bash scripts/migrations/test_012_013.sh
#
# Exit codes:
#   0  pass (or skipped)
#   1  any assertion failed

set -uo pipefail

if [[ -z "${DATABASE_URL_TEST:-}" ]]; then
  echo "── DATABASE_URL_TEST not set — skipping live PG test"
  exit 0
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIG_DIR="$ROOT/scripts/migrations"
TMP_DB="mig_test_$(date +%s)_$$"

# admin URL minus the trailing /<dbname>; we substitute /postgres for the
# CREATE DATABASE step, then point at /<TMP_DB> for the actual work.
ADMIN_URL="$(echo "$DATABASE_URL_TEST" | sed -E 's|/[^/?]+(\?.*)?$|/postgres\1|')"
TEST_URL="$(echo "$DATABASE_URL_TEST" | sed -E "s|/[^/?]+(\?.*)?$|/${TMP_DB}\1|")"

cleanup() {
  psql "$ADMIN_URL" -X -q -c "DROP DATABASE IF EXISTS \"${TMP_DB}\"" >/dev/null 2>&1 || true
}
trap cleanup EXIT

PASS=0
FAIL=0

red()   { printf "\033[31mFAIL\033[0m %s\n" "$1" >&2; FAIL=$((FAIL+1)); }
green() { printf "\033[32m PASS\033[0m %s\n" "$1"; PASS=$((PASS+1)); }

q() { psql "$TEST_URL" -X -q -t -A -c "$1"; }

assert_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then green "$name"
  else red "$name — expected '$expected', got '$actual'"; fi
}

assert_contains() {
  local name="$1" needle="$2" haystack="$3"
  if [[ "$haystack" == *"$needle"* ]]; then green "$name"
  else red "$name — '$needle' not in '$haystack'"; fi
}

assert_fails() {
  local name="$1" sql="$2"
  if psql "$TEST_URL" -X -q -c "$sql" >/dev/null 2>&1; then
    red "$name — SQL was expected to fail but succeeded"
  else
    green "$name"
  fi
}

# ── 0. Bootstrap ────────────────────────────────────────────────────────
echo "── Creating test database $TMP_DB"
psql "$ADMIN_URL" -X -q -c "CREATE DATABASE \"${TMP_DB}\"" || {
  echo "ERROR: cannot create test database" >&2; exit 1; }

# Stub outreach_messages — repo doesn't have its CREATE TABLE source. We
# bootstrap minimal columns matching the production schema observed in
# scripts/seed-dashboard.sql + features/inbound/orchestrator/thread/messages.go.
psql "$TEST_URL" -X -q -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE outreach_messages (
  id            BIGSERIAL PRIMARY KEY,
  thread_id     BIGINT NOT NULL,
  direction     TEXT NOT NULL CHECK (direction IN ('outbound','inbound')),
  message_id    TEXT,
  in_reply_to   TEXT,
  subject       TEXT,
  body_preview  TEXT,
  sent_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
SQL

# ── 1. Apply 011 ────────────────────────────────────────────────────────
echo "── Applying 012_outreach_messages_full_body.sql"
psql "$TEST_URL" -X -q -v ON_ERROR_STOP=1 -f "$MIG_DIR/012_outreach_messages_full_body.sql"
assert_eq "1.  011 applies cleanly" "0" "$?"

# Idempotency: apply twice
psql "$TEST_URL" -X -q -v ON_ERROR_STOP=1 -f "$MIG_DIR/012_outreach_messages_full_body.sql"
assert_eq "2.  011 is idempotent" "0" "$?"

# Column existence checks on outreach_messages
for col in body_text body_html body_html_raw body_size_bytes; do
  type=$(q "SELECT data_type FROM information_schema.columns WHERE table_name='outreach_messages' AND column_name='${col}'")
  case "$col" in
    body_size_bytes) want="integer" ;;
    *)               want="text"    ;;
  esac
  if [[ "$type" == "$want" ]]; then green "3.  outreach_messages.${col} is ${want}"
  else red "3.  outreach_messages.${col} expected ${want}, got '${type}'"; fi
done

# Nullable
for col in body_text body_html body_html_raw body_size_bytes; do
  nullable=$(q "SELECT is_nullable FROM information_schema.columns WHERE table_name='outreach_messages' AND column_name='${col}'")
  assert_eq "4.  outreach_messages.${col} is nullable" "YES" "$nullable"
done

# Existing rows untouched
psql "$TEST_URL" -X -q -v ON_ERROR_STOP=1 -c \
  "INSERT INTO outreach_messages (thread_id, direction, body_preview) VALUES (1, 'outbound', 'pre-existing')" >/dev/null
preview=$(q "SELECT body_preview FROM outreach_messages WHERE thread_id=1")
assert_eq "5.  legacy row insert (additive migration)" "pre-existing" "$preview"

# ── 2. Apply 012 ────────────────────────────────────────────────────────
echo "── Applying 013_message_attachments.sql"
psql "$TEST_URL" -X -q -v ON_ERROR_STOP=1 -f "$MIG_DIR/013_message_attachments.sql"
assert_eq "6.  012 applies cleanly" "0" "$?"

psql "$TEST_URL" -X -q -v ON_ERROR_STOP=1 -f "$MIG_DIR/013_message_attachments.sql"
assert_eq "7.  012 is idempotent" "0" "$?"

# Table + 10 columns (id, message_id, content_id, filename, content_type,
# size_bytes, sha256, data, is_inline, created_at)
col_count=$(q "SELECT count(*) FROM information_schema.columns WHERE table_name='message_attachments'")
assert_eq "8.  message_attachments has 10 columns" "10" "$col_count"

# FK to outreach_messages with CASCADE
fk=$(q "SELECT confdeltype FROM pg_constraint c WHERE conrelid='message_attachments'::regclass AND contype='f'")
assert_eq "9.  FK ON DELETE CASCADE (confdeltype='c')" "c" "$fk"

# is_inline default FALSE
default=$(q "SELECT column_default FROM information_schema.columns WHERE table_name='message_attachments' AND column_name='is_inline'")
assert_contains "10. is_inline DEFAULT false" "false" "$default"

# content_id is nullable
ci_null=$(q "SELECT is_nullable FROM information_schema.columns WHERE table_name='message_attachments' AND column_name='content_id'")
assert_eq "11. content_id is nullable" "YES" "$ci_null"

# All other key columns NOT NULL
for col in message_id filename content_type size_bytes sha256 data is_inline; do
  nn=$(q "SELECT is_nullable FROM information_schema.columns WHERE table_name='message_attachments' AND column_name='${col}'")
  assert_eq "12. ${col} NOT NULL" "NO" "$nn"
done

# Both indexes exist
idx_main=$(q "SELECT indexname FROM pg_indexes WHERE tablename='message_attachments' AND indexname='idx_message_attachments_message_id'")
assert_eq "13. idx_message_attachments_message_id exists" "idx_message_attachments_message_id" "$idx_main"

idx_cid=$(q "SELECT indexname FROM pg_indexes WHERE tablename='message_attachments' AND indexname='idx_message_attachments_cid'")
assert_eq "14. idx_message_attachments_cid exists" "idx_message_attachments_cid" "$idx_cid"

# Partial index has WHERE clause
idx_def=$(q "SELECT indexdef FROM pg_indexes WHERE indexname='idx_message_attachments_cid'")
assert_contains "15. idx_..._cid has WHERE NOT NULL" "WHERE (content_id IS NOT NULL)" "$idx_def"

# ── 3. Behavioral tests ─────────────────────────────────────────────────

# Insert a parent message + child attachment
parent_id=$(q "INSERT INTO outreach_messages(thread_id, direction, body_preview, body_text, body_html) VALUES (2, 'inbound', 'p', 'plain', '<b>html</b>') RETURNING id")
sha="$(printf '%064d' 1)"   # 64-char string of '0' + '1' filler

q "INSERT INTO message_attachments(message_id, content_id, filename, content_type, size_bytes, sha256, data, is_inline) \
   VALUES (${parent_id}, 'logo', 'logo.png', 'image/png', 5, '${sha}', '\\x00010203ff', true)" >/dev/null
att_count=$(q "SELECT count(*) FROM message_attachments WHERE message_id=${parent_id}")
assert_eq "16. inline attachment insert (cid='logo')" "1" "$att_count"

# Non-inline (cid NULL)
q "INSERT INTO message_attachments(message_id, filename, content_type, size_bytes, sha256, data) \
   VALUES (${parent_id}, 'doc.pdf', 'application/pdf', 2, '${sha}', '\\x4142')" >/dev/null
att_count=$(q "SELECT count(*) FROM message_attachments WHERE message_id=${parent_id}")
assert_eq "17. non-inline attachment insert (cid NULL)" "2" "$att_count"

# CHECK size_bytes >= 0
assert_fails "18. CHECK size_bytes>=0 enforced" \
  "INSERT INTO message_attachments(message_id, filename, content_type, size_bytes, sha256, data) VALUES (${parent_id}, 'bad.bin', 'application/octet-stream', -1, '${sha}', '\\x00')"

# CHECK length(sha256)=64
assert_fails "19. CHECK length(sha256)=64 enforced" \
  "INSERT INTO message_attachments(message_id, filename, content_type, size_bytes, sha256, data) VALUES (${parent_id}, 'bad2.bin', 'application/octet-stream', 1, 'tooshort', '\\x00')"

# 5MB blob accepted (use repeat() in PG)
q "INSERT INTO message_attachments(message_id, filename, content_type, size_bytes, sha256, data) \
   VALUES (${parent_id}, 'big.bin', 'application/octet-stream', 5242880, '${sha}', repeat('a', 5242880)::bytea)" >/dev/null
big_size=$(q "SELECT octet_length(data) FROM message_attachments WHERE filename='big.bin'")
assert_eq "20. 5MB BYTEA round-trip" "5242880" "$big_size"

# CASCADE delete: drop parent, children gone
q "DELETE FROM outreach_messages WHERE id=${parent_id}" >/dev/null
remaining=$(q "SELECT count(*) FROM message_attachments WHERE message_id=${parent_id}")
assert_eq "21. ON DELETE CASCADE wipes attachments" "0" "$remaining"

# ── Summary ─────────────────────────────────────────────────────────────
echo
echo "── Results: ${PASS} passed, ${FAIL} failed"
if [[ $FAIL -gt 0 ]]; then exit 1; fi
exit 0
