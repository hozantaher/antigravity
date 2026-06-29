import { type Kysely, sql } from 'kysely'

// Deterministic listing-enrichment sweep state (cron enrich-listings). createItem/updateItem stamp
// 'pending' when there's auto-fillable work (VIN decode into empty specs, DeepL into empty locales);
// the cron claim-CAS flips 'pending' → 'processing' → 'ready'/'failed'. Origin-agnostic: covers both
// admin-created and feed-imported (AutoLine) items. Server-only columns; not in the Item model.
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable('items')
    .addColumn('enrichment_status', 'text', col => col.notNull().defaultTo('idle'))
    .addColumn('enrichment_claimed_at', 'timestamptz')
    .addColumn('enrichment_attempts', 'integer', col => col.notNull().defaultTo(0))
    .addColumn('enrichment_error', 'text')
    .execute()

  // The sweep selects WHERE enrichment_status = 'pending' — a partial index keeps that probe cheap
  // as the items table grows (the vast majority of rows are 'idle'/'ready').
  await sql`CREATE INDEX IF NOT EXISTS items_enrichment_pending_idx ON items (enrichment_status) WHERE enrichment_status = 'pending'`.execute(
    db,
  )
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await sql`DROP INDEX IF EXISTS items_enrichment_pending_idx`.execute(db)
  await db.schema.alterTable('items').dropColumn('enrichment_status').execute()
  await db.schema.alterTable('items').dropColumn('enrichment_claimed_at').execute()
  await db.schema.alterTable('items').dropColumn('enrichment_attempts').execute()
  await db.schema.alterTable('items').dropColumn('enrichment_error').execute()
}
