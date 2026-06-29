import { type Kysely, sql } from 'kysely'

export const up = async (db: Kysely<unknown>): Promise<void> => {
  // unaccentLikeAny folds diacritics with unaccent() at query time
  // (lower(unaccent(col)) like lower(unaccent($q))). Needs the contrib extension.
  await sql`CREATE EXTENSION IF NOT EXISTS unaccent`.execute(db)
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await sql`DROP EXTENSION IF EXISTS unaccent`.execute(db)
}
