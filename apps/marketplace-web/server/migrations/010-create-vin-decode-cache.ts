import { type Kysely, sql } from 'kysely'

// Durable cache of Vincario VIN decodes. A VIN always decodes to the same vehicle, so the cache is
// permanent and keyed by VIN — every repeat decode is a free PK lookup instead of a paid Vincario
// call. raw_response keeps the verbatim payload for audit / future re-mapping; decoded_by has no FK
// (audit breadcrumb that must outlive an admin account deletion).
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('vin_decode_cache')
    .addColumn('vin', 'text', col => col.primaryKey())
    .addColumn('normalized', 'jsonb', col => col.notNull())
    .addColumn('raw_response', 'jsonb', col => col.notNull())
    .addColumn('price', 'numeric')
    .addColumn('price_currency', 'text')
    .addColumn('decoded_by', 'text')
    .addColumn('decoded_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('vin_decode_cache').ifExists().execute()
}
