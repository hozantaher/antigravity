import { type Kysely, sql } from 'kysely'

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('invoices')
    .addColumn('id', 'text', col => col.primaryKey())
    .addColumn('user_id', 'text', col => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('created_date', 'timestamptz')
    .addColumn('invoice_created_date', 'timestamptz')
    .addColumn('invoice_due_date', 'timestamptz')
    .addColumn('paid_at', 'timestamptz')
    .addColumn('status', 'text', col => col.notNull().defaultTo('unpaid'))
    .addColumn('price_amount', sql`numeric(20, 2)`)
    .addColumn('price_currency', 'text')
    .addColumn('url', 'text')
    .execute()

  await db.schema.createIndex('invoices_user_id_idx').on('invoices').column('user_id').execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('invoices').ifExists().execute()
}
