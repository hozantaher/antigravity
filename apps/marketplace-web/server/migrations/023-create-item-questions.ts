import { type Kysely, sql } from 'kysely'

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('item_questions')
    .addColumn('id', 'bigserial', col => col.primaryKey())
    // A question is listing-scoped content (cascade with the item), unlike a durable contact lead.
    .addColumn('item_id', 'text', col => col.notNull().references('items.id').onDelete('cascade'))
    .addColumn('user_id', 'text', col => col.notNull().references('users.id').onDelete('restrict'))
    .addColumn('body', 'text', col => col.notNull())
    .addColumn('answer', 'text')
    // Soft ref (no FK): the answering admin id survives that admin's account deletion.
    .addColumn('answered_by', 'text')
    // 'pending' (default, hidden) | 'published' (public) | 'hidden'. Moderated before public.
    .addColumn('status', 'text', col => col.notNull().defaultTo('pending'))
    .addColumn('created', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addColumn('answered_at', 'timestamptz')
    .execute()

  await db.schema
    .createIndex('item_questions_item_id_created_idx')
    .on('item_questions')
    .columns(['item_id', 'created desc'])
    .execute()
  await db.schema.createIndex('item_questions_user_id_idx').on('item_questions').column('user_id').execute()
  await db.schema.createIndex('item_questions_status_idx').on('item_questions').column('status').execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('item_questions').ifExists().execute()
}
