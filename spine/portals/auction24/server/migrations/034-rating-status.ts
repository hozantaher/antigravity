import type { Kysely } from 'kysely'

// Moderation status for ratings. Mirrors item_questions.status: a rating is 'visible' by default;
// an admin can 'hidden' it (fraud / abuse). Hidden ratings are excluded from seller reputation.
// No delete — the row is kept (audit + the UNIQUE(invoice_id) anti-refake guard stays intact).
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable('item_ratings')
    .addColumn('status', 'text', col => col.notNull().defaultTo('visible'))
    .execute()
  await db.schema.createIndex('item_ratings_status_idx').on('item_ratings').column('status').execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropIndex('item_ratings_status_idx').ifExists().execute()
  await db.schema.alterTable('item_ratings').dropColumn('status').execute()
}
