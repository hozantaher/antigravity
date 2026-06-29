import { type Kysely, sql } from 'kysely'

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('notifications')
    .addColumn('id', 'bigserial', col => col.primaryKey())
    .addColumn('user_id', 'text', col => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('type', 'text', col => col.notNull())
    // Soft link to the listing the event is about (cascade with the item). Nullable for future
    // non-item notifications.
    .addColumn('item_id', 'text', col => col.references('items.id').onDelete('cascade'))
    .addColumn('title', 'text', col => col.notNull())
    // Idempotence: raising the same event twice (an overlapping close sweep, a retried request) hits
    // this UNIQUE and is a no-op — the badge never double-counts.
    .addColumn('dedupe_key', 'text', col => col.notNull().unique())
    .addColumn('read_at', 'timestamptz')
    .addColumn('created', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .execute()

  // The list + unread badge both read by recipient, newest first.
  await db.schema
    .createIndex('notifications_user_id_created_idx')
    .on('notifications')
    .columns(['user_id', 'created desc'])
    .execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('notifications').ifExists().execute()
}
