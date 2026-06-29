#!/usr/bin/env bash
# sync-firmy-from-prod.sh
#
# Synchronize firmy/source tables from Railway production Postgres to local firmy DB.
# Supports:
#   - full refresh (truncate + refill)
#   - incremental sync (watermark on scraped_at + upsert on PK)
#
# Defaults:
#   TARGET_DSN=postgresql://firmy:firmy@localhost:5434/firmy
#   SYNC_MODE=incremental
#   SYNC_TABLES="firmy_cz_businesses judikaty_decisions autoline_listings esbirka_acts mascus_cz_listings mobile_de_listings"
#
# Required:
#   SOURCE_DSN must point to production/public Postgres endpoint
#
# Optional:
#   SOURCE_DSN can be auto-detected via Railway CLI (Postgres service in production env)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

SOURCE_DSN="${SOURCE_DSN:-}"
TARGET_DSN="${TARGET_DSN:-postgresql://firmy:firmy@localhost:5434/firmy}"
SYNC_MODE="${SYNC_MODE:-incremental}"
SYNC_TABLES="${SYNC_TABLES:-firmy_cz_businesses judikaty_decisions autoline_listings esbirka_acts mascus_cz_listings mobile_de_listings}"
FORCE_SCHEMA_REFRESH="${FORCE_SCHEMA_REFRESH:-0}"

if [[ "$SYNC_MODE" != "incremental" && "$SYNC_MODE" != "full" ]]; then
  echo "ERROR: SYNC_MODE must be 'incremental' or 'full' (got '$SYNC_MODE')"
  exit 1
fi

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: missing required command: $1"
    exit 1
  fi
}

sql_escape_literal() {
  local s="$1"
  s="${s//\'/\'\'}"
  printf "%s" "$s"
}

sanitize_table_name() {
  local table="$1"
  if [[ ! "$table" =~ ^[a-zA-Z0-9_]+$ ]]; then
    echo "ERROR: invalid table name '$table'"
    exit 1
  fi
}

psql_scalar_target() {
  local sql="$1"
  psql "$TARGET_DSN" -Atq -v ON_ERROR_STOP=1 -c "$sql"
}

psql_scalar_source() {
  local sql="$1"
  psql "$SOURCE_DSN" -Atq -v ON_ERROR_STOP=1 -c "$sql"
}

ensure_sync_state_table() {
  psql "$TARGET_DSN" -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE IF NOT EXISTS sync_state (
  table_name TEXT PRIMARY KEY,
  last_scraped_at TEXT,
  last_full_sync_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
SQL
}

auto_detect_source_dsn() {
  if [[ -n "$SOURCE_DSN" ]]; then
    return
  fi
  if ! command -v railway >/dev/null 2>&1; then
    return
  fi
  if ! command -v jq >/dev/null 2>&1; then
    return
  fi

  local detected
  set +e
  detected="$(cd "$ROOT" && railway variable list --service Postgres --environment production --json 2>/dev/null | jq -r '.DATABASE_PUBLIC_URL // empty' 2>/dev/null)"
  set -e
  if [[ -n "$detected" ]]; then
    SOURCE_DSN="$detected"
  fi
}

ensure_table_schema() {
  local table="$1"
  local source_exists target_exists
  source_exists="$(psql_scalar_source "SELECT to_regclass('public.${table}') IS NOT NULL;")"
  if [[ "$source_exists" != "t" ]]; then
    echo "WARN: source table '$table' not found, skipping"
    return 1
  fi

  target_exists="$(psql_scalar_target "SELECT to_regclass('public.${table}') IS NOT NULL;")"
  if [[ "$target_exists" == "t" && "$FORCE_SCHEMA_REFRESH" != "1" ]]; then
    return 0
  fi

  echo "  - Ensuring schema for '$table' in target"
  if [[ "$target_exists" == "t" && "$FORCE_SCHEMA_REFRESH" == "1" ]]; then
    psql "$TARGET_DSN" -v ON_ERROR_STOP=1 -c "DROP TABLE IF EXISTS public.\"${table}\" CASCADE;" >/dev/null
  fi

  target_exists="$(psql_scalar_target "SELECT to_regclass('public.${table}') IS NOT NULL;")"
  if [[ "$target_exists" == "t" ]]; then
    return 0
  fi

  local table_lit col_defs pk_cols ddl
  table_lit="$(sql_escape_literal "$table")"
  col_defs="$(psql_scalar_source "SELECT string_agg(format('%I %s%s', a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod), CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END), ', ' ORDER BY a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = '${table_lit}' AND a.attnum > 0 AND NOT a.attisdropped;")"
  if [[ -z "$col_defs" ]]; then
    echo "WARN: could not inspect source columns for '$table'"
    return 1
  fi

  pk_cols="$(psql_scalar_source "SELECT string_agg(format('%I', a.attname), ', ' ORDER BY a.attnum) FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(i.indkey) WHERE n.nspname = 'public' AND t.relname = '${table_lit}' AND i.indisprimary;")"

  ddl="CREATE TABLE public.\"${table}\" (${col_defs}"
  if [[ -n "$pk_cols" ]]; then
    ddl+=", PRIMARY KEY (${pk_cols})"
  fi
  ddl+=");"
  psql "$TARGET_DSN" -v ON_ERROR_STOP=1 -c "$ddl" >/dev/null
}

get_table_columns_csv() {
  local table="$1"
  psql_scalar_target "SELECT string_agg(format('%I', column_name), ', ' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='${table}';"
}

get_pk_columns_csv() {
  local table="$1"
  psql_scalar_target "SELECT string_agg(format('%I', a.attname), ', ' ORDER BY a.attnum) FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum = ANY(i.indkey) WHERE i.indisprimary AND t.relname='${table}';"
}

has_scraped_at_column() {
  local table="$1"
  local exists
  exists="$(psql_scalar_target "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='${table}' AND column_name='scraped_at');")"
  [[ "$exists" == "t" ]]
}

full_sync_table() {
  local table="$1"
  local cols="$2"
  local staging="sync_staging_${table}"

  echo "  - Full refresh"
  psql "$TARGET_DSN" -v ON_ERROR_STOP=1 -c "DROP TABLE IF EXISTS public.\"${staging}\"; CREATE TABLE public.\"${staging}\" (LIKE public.\"${table}\" INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES);"

  psql "$SOURCE_DSN" -v ON_ERROR_STOP=1 -c "\\copy (SELECT ${cols} FROM public.\"${table}\") TO STDOUT WITH CSV" | \
    psql "$TARGET_DSN" -v ON_ERROR_STOP=1 -c "\\copy public.\"${staging}\" (${cols}) FROM STDIN WITH CSV"

  local loaded
  loaded="$(psql_scalar_target "SELECT COUNT(*) FROM public.\"${staging}\";")"

  psql "$TARGET_DSN" -v ON_ERROR_STOP=1 -c "TRUNCATE TABLE public.\"${table}\"; INSERT INTO public.\"${table}\" (${cols}) SELECT ${cols} FROM public.\"${staging}\";"

  local max_scraped
  if has_scraped_at_column "$table"; then
    max_scraped="$(psql_scalar_target "SELECT COALESCE(MAX(scraped_at), '') FROM public.\"${table}\";")"
  else
    max_scraped=""
  fi

  psql "$TARGET_DSN" -v ON_ERROR_STOP=1 -c "INSERT INTO sync_state(table_name, last_scraped_at, last_full_sync_at, updated_at) VALUES ('${table}', NULLIF('${max_scraped}', ''), now(), now()) ON CONFLICT (table_name) DO UPDATE SET last_scraped_at = EXCLUDED.last_scraped_at, last_full_sync_at = EXCLUDED.last_full_sync_at, updated_at = now();"

  echo "    Loaded rows: ${loaded}"
}

incremental_sync_table() {
  local table="$1"
  local cols="$2"
  local pk_cols="$3"
  local staging="sync_staging_${table}"

  if ! has_scraped_at_column "$table"; then
    echo "  - No scraped_at column; falling back to full refresh"
    full_sync_table "$table" "$cols"
    return
  fi

  local watermark
  watermark="$(psql_scalar_target "SELECT COALESCE((SELECT last_scraped_at FROM sync_state WHERE table_name='${table}'), '1970-01-01 00:00:00');")"

  psql "$TARGET_DSN" -v ON_ERROR_STOP=1 -c "DROP TABLE IF EXISTS public.\"${staging}\"; CREATE TABLE public.\"${staging}\" (LIKE public.\"${table}\" INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES);"

  psql "$SOURCE_DSN" -v ON_ERROR_STOP=1 -c "\\copy (SELECT ${cols} FROM public.\"${table}\" WHERE COALESCE(scraped_at, '') > '${watermark}') TO STDOUT WITH CSV" | \
    psql "$TARGET_DSN" -v ON_ERROR_STOP=1 -c "\\copy public.\"${staging}\" (${cols}) FROM STDIN WITH CSV"

  local delta_count
  delta_count="$(psql_scalar_target "SELECT COUNT(*) FROM public.\"${staging}\";")"
  if [[ "$delta_count" == "0" ]]; then
    echo "  - Incremental: no new rows (watermark: ${watermark})"
    return
  fi

  local update_set
  update_set="$(psql_scalar_target "SELECT string_agg(format('%I = EXCLUDED.%I', column_name, column_name), ', ' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='${table}' AND column_name <> ALL(string_to_array(replace('${pk_cols}', ' ', ''), ','));")"

  if [[ -n "$pk_cols" ]]; then
    if [[ -n "$update_set" ]]; then
      psql "$TARGET_DSN" -v ON_ERROR_STOP=1 -c "INSERT INTO public.\"${table}\" (${cols}) SELECT ${cols} FROM public.\"${staging}\" ON CONFLICT (${pk_cols}) DO UPDATE SET ${update_set};"
    else
      psql "$TARGET_DSN" -v ON_ERROR_STOP=1 -c "INSERT INTO public.\"${table}\" (${cols}) SELECT ${cols} FROM public.\"${staging}\" ON CONFLICT (${pk_cols}) DO NOTHING;"
    fi
  else
    echo "  - No primary key found; appending delta rows without upsert"
    psql "$TARGET_DSN" -v ON_ERROR_STOP=1 -c "INSERT INTO public.\"${table}\" (${cols}) SELECT ${cols} FROM public.\"${staging}\";"
  fi

  local new_watermark
  new_watermark="$(psql_scalar_target "SELECT COALESCE(MAX(scraped_at), '') FROM public.\"${staging}\";")"

  psql "$TARGET_DSN" -v ON_ERROR_STOP=1 -c "INSERT INTO sync_state(table_name, last_scraped_at, updated_at) VALUES ('${table}', NULLIF('${new_watermark}', ''), now()) ON CONFLICT (table_name) DO UPDATE SET last_scraped_at = EXCLUDED.last_scraped_at, updated_at = now();"

  echo "  - Incremental: upserted rows: ${delta_count}, watermark: ${watermark} -> ${new_watermark}"
}

main() {
  need_cmd psql

  auto_detect_source_dsn

  if [[ -z "$SOURCE_DSN" ]]; then
    cat <<'EOF'
ERROR: SOURCE_DSN is not set.

Set SOURCE_DSN to Railway public Postgres URL, for example:
  SOURCE_DSN='postgresql://...@...proxy.rlwy.net:PORT/railway' ./scripts/sync-firmy-from-prod.sh

Or run from linked project where Railway CLI can auto-detect:
  railway variable list --service Postgres --environment production --json
EOF
    exit 1
  fi

  echo "Sync started"
  echo "  Mode:          ${SYNC_MODE}"
  echo "  Source DB:     [set]"
  echo "  Target DB:     ${TARGET_DSN}"
  echo "  Tables:        ${SYNC_TABLES}"
  echo ""

  psql "$SOURCE_DSN" -v ON_ERROR_STOP=1 -c "SELECT 1;" >/dev/null
  psql "$TARGET_DSN" -v ON_ERROR_STOP=1 -c "SELECT 1;" >/dev/null

  ensure_sync_state_table

  for table in $SYNC_TABLES; do
    sanitize_table_name "$table"
    echo "== ${table} =="

    if ! ensure_table_schema "$table"; then
      continue
    fi

    local cols pk_cols
    cols="$(get_table_columns_csv "$table")"
    if [[ -z "$cols" ]]; then
      echo "  - No columns discovered, skipping"
      continue
    fi
    pk_cols="$(get_pk_columns_csv "$table")"

    if [[ "$SYNC_MODE" == "full" ]]; then
      full_sync_table "$table" "$cols"
    else
      incremental_sync_table "$table" "$cols" "$pk_cols"
    fi
  done

  echo ""
  echo "Sync done."
  echo "Tip: run periodic full sync to reconcile deletions (incremental sync is insert/update oriented)."
}

main "$@"
