import { type Kysely, sql } from 'kysely'

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('contact_messages')
    // 'contact' (general sell-your-vehicle form) | 'offer' (price offer on a listing).
    .addColumn('kind', 'text', col => col.notNull())
    .addColumn('id', 'text', col => col.primaryKey())
    .addColumn('name', 'text')
    .addColumn('email', 'text')
    .addColumn('phone', 'text')
    .addColumn('location', 'text')
    .addColumn('vehicle', 'text')
    .addColumn('message', 'text')
    // Soft references (no FK): a message is a durable record that must survive the
    // item or user being deleted, so it's never cascaded away.
    .addColumn('item_id', 'text')
    .addColumn('user_id', 'text')
    .addColumn('offer_amount', sql`numeric(20, 2)`)
    .addColumn('offer_currency', 'text')
    .addColumn('status', 'text', col => col.notNull().defaultTo('new'))
    // Stamped once the ops notification e-mail is enqueued; null = not notified.
    .addColumn('notified_at', 'timestamptz')
    .addColumn('created', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema.createIndex('contact_messages_created_idx').on('contact_messages').column('created').execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('contact_messages').ifExists().execute()
}
