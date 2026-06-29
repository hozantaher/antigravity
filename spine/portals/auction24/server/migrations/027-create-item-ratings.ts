import { type Kysely, sql } from 'kysely'

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('item_ratings')
    .addColumn('id', 'bigserial', col => col.primaryKey())
    // Listing-scoped content (cascade with the item). seller_id/rater_id restrict — a rating outlives
    // neither party silently.
    .addColumn('item_id', 'text', col => col.notNull().references('items.id').onDelete('cascade'))
    .addColumn('seller_id', 'text', col => col.notNull().references('users.id').onDelete('restrict'))
    .addColumn('rater_id', 'text', col => col.notNull().references('users.id').onDelete('restrict'))
    // One paid sale invoice → at most one rating. UNIQUE is the anti-fake-reputation guard: you can
    // only rate a sale you actually settled, and only once.
    .addColumn('invoice_id', 'text', col => col.notNull().unique().references('invoices.id').onDelete('restrict'))
    .addColumn('score', 'integer', col => col.notNull().check(sql`score between 1 and 5`))
    .addColumn('comment', 'text')
    .addColumn('created', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .execute()

  // Reputation aggregation reads by seller; the public thread reads by item.
  await db.schema.createIndex('item_ratings_seller_id_idx').on('item_ratings').column('seller_id').execute()
  await db.schema.createIndex('item_ratings_item_id_idx').on('item_ratings').column('item_id').execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('item_ratings').ifExists().execute()
}
