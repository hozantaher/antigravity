import { type Kysely, sql } from 'kysely'

export const up = async (db: Kysely<unknown>): Promise<void> => {
  // 003 and 008 both created an identical (item_id, date desc) index under different
  // names — drop the 003 one so the bid hot path maintains a single index, not two.
  await sql`DROP INDEX IF EXISTS bids_item_id_date_idx`.execute(db)

  // Admin authorization checks roles in app code (roles.includes), never via a SQL
  // containment query, so this GIN index is pure write overhead — drop it.
  await sql`DROP INDEX IF EXISTS users_roles_gin_idx`.execute(db)

  // Substring search is lower(unaccent(col)) LIKE '%term%' — a leading wildcard over a
  // function-wrapped column that no btree can serve, so every search seq-scans. pg_trgm
  // GIN indexes fix that, but a functional index needs an IMMUTABLE expression and
  // unaccent() is only STABLE. Wrap it (pinning the dictionary makes it safe to mark
  // immutable — the documented pattern) and have unaccentLikeAny() call the same wrapper
  // so the planner matches the index expression.
  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`.execute(db)
  await sql`
    CREATE OR REPLACE FUNCTION immutable_unaccent(text)
    RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
    AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$
  `.execute(db)

  const trgmIndex = (name: string, table: string, column: string) =>
    sql`
      CREATE INDEX IF NOT EXISTS ${sql.raw(name)} ON ${sql.raw(table)}
      USING gin (lower(immutable_unaccent(coalesce(${sql.raw(column)}::text, ''))) gin_trgm_ops)
    `.execute(db)

  await trgmIndex('items_title_trgm_idx', 'items', 'title')
  await trgmIndex('items_location_trgm_idx', 'items', 'location')
  await trgmIndex('items_internal_id_trgm_idx', 'items', 'internal_id')
  await trgmIndex('users_full_name_trgm_idx', 'users', 'full_name')
  await trgmIndex('users_email_trgm_idx', 'users', 'email')
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await sql`DROP INDEX IF EXISTS items_title_trgm_idx`.execute(db)
  await sql`DROP INDEX IF EXISTS items_location_trgm_idx`.execute(db)
  await sql`DROP INDEX IF EXISTS items_internal_id_trgm_idx`.execute(db)
  await sql`DROP INDEX IF EXISTS users_full_name_trgm_idx`.execute(db)
  await sql`DROP INDEX IF EXISTS users_email_trgm_idx`.execute(db)
  // immutable_unaccent stays — unaccentLikeAny still references it. Restore the indexes
  // this migration dropped so a rollback returns the schema to its prior shape.
  await sql`CREATE INDEX IF NOT EXISTS bids_item_id_date_idx ON bids (item_id, date desc)`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS users_roles_gin_idx ON users USING gin (roles)`.execute(db)
}
