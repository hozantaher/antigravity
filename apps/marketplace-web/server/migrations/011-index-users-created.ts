import { type Kysely, sql } from 'kysely'

// Backs the admin users list: ORDER BY created DESC, id ASC + LIMIT/OFFSET.
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await sql`CREATE INDEX IF NOT EXISTS users_created_idx ON users (created DESC)`.execute(db)
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await sql`DROP INDEX IF EXISTS users_created_idx`.execute(db)
}
