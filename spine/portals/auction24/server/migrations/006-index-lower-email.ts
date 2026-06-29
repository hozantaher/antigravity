import { type Kysely, sql } from 'kysely'

export const up = async (db: Kysely<unknown>): Promise<void> => {
  // getByEmail filters `lower(email) = ?` (case-insensitive login / reset lookup);
  // the plain index on raw email can't serve that predicate, so logins seq-scanned
  // users. Replace it with a functional index — nothing queries raw email equality.
  await sql`DROP INDEX IF EXISTS users_email_idx`.execute(db)
  await sql`CREATE INDEX users_email_lower_idx ON users (lower(email))`.execute(db)
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await sql`DROP INDEX IF EXISTS users_email_lower_idx`.execute(db)
  await sql`CREATE INDEX users_email_idx ON users (email)`.execute(db)
}
