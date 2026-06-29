import { type Kysely, sql } from 'kysely'

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('api_tokens')
    .addColumn('id', 'text', col => col.primaryKey())
    .addColumn('name', 'text', col => col.notNull())
    // Only the HMAC-SHA256 hash is persisted; unique so a hash collision can't shadow a token.
    .addColumn('token_hash', 'text', col => col.notNull().unique())
    .addColumn('token_prefix', 'text', col => col.notNull())
    .addColumn('created_by', 'text', col => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addColumn('last_used_at', 'timestamptz')
    .execute()

  await db.schema.createIndex('api_tokens_created_by_idx').on('api_tokens').column('created_by').execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('api_tokens').ifExists().execute()
}
