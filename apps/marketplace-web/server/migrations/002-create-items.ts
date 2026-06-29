import { type Kysely, sql } from 'kysely'

// Mirrors the i18n category keys + SVG icon filenames in the frontend.
const CATEGORY_IDS = ['car', 'moto', 'motorhome', 'vut75', 'to75', 'av', 'stt', 't', 'st', 'cm', 'bus', 'ft', 'others']

export const up = async (db: Kysely<unknown>): Promise<void> => {
  const categoryCheck = CATEGORY_IDS.map(s => `'${s}'`).join(', ')

  await db.schema
    .createTable('items')
    .addColumn('id', 'text', col => col.primaryKey())
    .addColumn('internal_id', 'text')
    .addColumn('title', 'text', col => col.notNull())
    .addColumn('image', 'text', col => col.notNull().defaultTo(''))
    .addColumn('images', sql`text[]`, col => col.notNull().defaultTo(sql`'{}'::text[]`))
    .addColumn('images360', sql`text[]`, col => col.notNull().defaultTo(sql`'{}'::text[]`))
    .addColumn('description', 'jsonb')
    .addColumn('highlights', 'jsonb')
    .addColumn('minimal_price_amount', sql`numeric(20, 2)`)
    .addColumn('minimal_price_currency', 'text')
    .addColumn('price_from_amount', sql`numeric(20, 2)`)
    .addColumn('price_from_currency', 'text')
    .addColumn('min_bid_amount', sql`numeric(20, 2)`)
    .addColumn('min_bid_currency', 'text')
    .addColumn('category_id', 'text', col => col.notNull().check(sql.raw(`category_id IN (${categoryCheck})`)))
    .addColumn('user_id', 'text', col => col.notNull().references('users.id').onDelete('restrict'))
    .addColumn('location', 'text')
    .addColumn('country_code', 'text')
    .addColumn('youtube_video_id', 'text')
    .addColumn('price_highlighted', 'boolean', col => col.notNull().defaultTo(false))
    .addColumn('tax_included', 'boolean', col => col.notNull().defaultTo(false))
    .addColumn('sold', 'boolean', col => col.notNull().defaultTo(false))
    .addColumn('closed', 'boolean', col => col.notNull().defaultTo(false))
    .addColumn('hidden', 'boolean', col => col.notNull().defaultTo(false))
    .addColumn('winner', 'jsonb')
    .addColumn('email', 'text')
    .addColumn('phone', 'text')
    .addColumn('start_date', 'timestamptz')
    .addColumn('end_date', 'timestamptz')
    .addColumn('type', 'text', col => col.notNull().check(sql`type IN ('auction', 'ad')`))
    .addColumn('created', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated', 'timestamptz')
    .addColumn('visible_updated', 'timestamptz')
    .addColumn('gps', 'jsonb')
    .execute()

  await db.schema.createIndex('items_listing_idx').on('items').columns(['type', 'sold', 'hidden']).execute()
  await db.schema.createIndex('items_category_id_idx').on('items').column('category_id').execute()
  await db.schema.createIndex('items_user_id_idx').on('items').column('user_id').execute()
  await db.schema.createIndex('items_end_date_idx').on('items').column('end_date').execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('items').ifExists().execute()
}
