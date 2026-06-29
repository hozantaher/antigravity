import { type Kysely, sql } from 'kysely'

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('disputes')
    .addColumn('id', 'bigserial', col => col.primaryKey())
    .addColumn('item_id', 'text', col => col.notNull().references('items.id').onDelete('cascade'))
    // One settled sale → one case. UNIQUE binds the complaint to a real transaction and blocks dupes.
    .addColumn('invoice_id', 'text', col => col.notNull().unique().references('invoices.id').onDelete('restrict'))
    .addColumn('opener_id', 'text', col => col.notNull().references('users.id').onDelete('restrict'))
    .addColumn('reason', 'text', col => col.notNull())
    // open | review | resolved. Forward-only; resolved is terminal.
    .addColumn('status', 'text', col => col.notNull().defaultTo('open'))
    .addColumn('resolution', 'text')
    // Soft ref (no FK): the resolving ops admin id survives that admin's account deletion.
    .addColumn('resolved_by', 'text')
    .addColumn('resolved_at', 'timestamptz')
    .addColumn('created', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema.createIndex('disputes_opener_id_idx').on('disputes').column('opener_id').execute()
  await db.schema.createIndex('disputes_status_idx').on('disputes').column('status').execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('disputes').ifExists().execute()
}
