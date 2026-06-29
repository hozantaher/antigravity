import { type Kysely, sql } from 'kysely'

// /api/search ORs the plain text columns (title/location/internal_id — indexed in 014) with two
// JSONB extractions (description/highlights). A single un-indexable OR branch makes Postgres
// seq-scan the whole table, so 014's trgm indexes never serve the public search. These two GIN
// trgm indexes cover the JSONB branches with the SAME expression unaccentLikeAny() emits
// (server/utils/search.ts) — the jsonpath stays a literal so the planner matches it — letting it
// bitmap-OR all five branches instead of seq-scanning. Depends on 014 (pg_trgm + immutable_unaccent).
const jsonbTrgmIndex = (db: Kysely<unknown>, name: string, column: string) =>
  sql`
    CREATE INDEX IF NOT EXISTS ${sql.raw(name)} ON items
    USING gin (
      lower(immutable_unaccent(coalesce(
        (jsonb_path_query_array(${sql.raw(column)}, '$.** ? (@.type() == "string")'))::text, ''
      ))) gin_trgm_ops
    )
  `.execute(db)

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await jsonbTrgmIndex(db, 'items_description_trgm_idx', 'description')
  await jsonbTrgmIndex(db, 'items_highlights_trgm_idx', 'highlights')
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await sql`DROP INDEX IF EXISTS items_description_trgm_idx`.execute(db)
  await sql`DROP INDEX IF EXISTS items_highlights_trgm_idx`.execute(db)
}
