import { type Kysely, sql } from 'kysely'

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('bids')
    .addColumn('id', 'bigserial', col => col.primaryKey())
    .addColumn('item_id', 'text', col => col.notNull().references('items.id').onDelete('cascade'))
    .addColumn('user_id', 'text', col => col.notNull().references('users.id').onDelete('restrict'))
    .addColumn('amount', sql`numeric(20, 2)`)
    .addColumn('currency_code', 'text')
    .addColumn('date', 'timestamptz', col => col.notNull())
    .addColumn('avatar_url', 'text')
    .execute()

  await db.schema.createIndex('bids_item_id_date_idx').on('bids').columns(['item_id', 'date desc']).execute()
  await db.schema.createIndex('bids_user_id_idx').on('bids').column('user_id').execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('bids').ifExists().execute()
}
