import { type Kysely, sql } from 'kysely'

// Saved searches (the saved-search domain): a user persists a named SearchQuery and opts into email
// alerts. query is jsonb (the stored SearchQuery); last_alerted_at is the server-only alert CAS stamp
// (NULL = never alerted). user_id cascades — a saved search is meaningless without its owner.

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('saved_searches')
    .addColumn('id', 'text', col => col.primaryKey())
    .addColumn('user_id', 'text', col => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('name', 'text', col => col.notNull())
    .addColumn('query', 'jsonb', col => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('alert_enabled', 'boolean', col => col.notNull().defaultTo(true))
    // Nullable, server-only CAS stamp for the alert cron.
    .addColumn('last_alerted_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz')
    .execute()

  // List-for-user + per-user cap count.
  await db.schema.createIndex('saved_searches_user_idx').on('saved_searches').column('user_id').execute()

  // The due-scan only cares about alert-enabled rows; partial index keeps it lean. ORDER BY
  // last_alerted_at asc nulls first (never-alerted first) is served by this index.
  await sql`CREATE INDEX saved_searches_due_idx ON saved_searches (last_alerted_at) WHERE alert_enabled`.execute(db)
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('saved_searches').ifExists().execute()
}
