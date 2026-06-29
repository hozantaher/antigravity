import { type Kysely, sql } from 'kysely'

// Performance indexes (audit follow-up). Three concerns:
//
// 1. The public listing (default grid, category pages, live rail, facet search) filters
//    `NOT sold AND NOT hidden` but no index covered that predicate — `items_listing_idx`
//    leads with `type`, unconstrained on the dominant path, so Postgres seq-scanned items.
//    Partial indexes over the visible set prune the scan to live rows before the (unindexable,
//    now()-based) sort runs.
// 2. The unread-notifications badge counts `user_id = ? AND read_at IS NULL` on every fetch;
//    the only index was (user_id, created), so a user with many read rows walked them all.
// 3. The Fio cron matches open invoices by `ltrim(variable_symbol,'0')` — a FUNCTIONAL predicate
//    that the existing bare-column `invoices_open_deposit_idx` cannot serve. Replace it with a
//    functional index, and add the missing sale-side counterpart.

export const up = async (db: Kysely<unknown>): Promise<void> => {
  // 1. Visible-listing partial indexes.
  await sql`CREATE INDEX IF NOT EXISTS items_visible_category_idx ON items (category_id) WHERE NOT sold AND NOT hidden`.execute(
    db,
  )
  await sql`CREATE INDEX IF NOT EXISTS items_visible_end_idx ON items (end_date) WHERE NOT sold AND NOT hidden`.execute(
    db,
  )
  // Common facet browse ("diesel SUV under X") with no text term — leading columns cover the
  // frequent body_type/fuel_type/price combos; bitmap-AND handles the rest on the pruned set.
  await sql`CREATE INDEX IF NOT EXISTS items_visible_facets_idx ON items (body_type, fuel_type, price_from_amount) WHERE NOT sold AND NOT hidden`.execute(
    db,
  )

  // 2. Unread-badge partial index.
  await sql`CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL`.execute(
    db,
  )

  // 3. Functional VS-match indexes. The old bare-column deposit index never served its own
  //    ltrim() query — drop it and recreate as functional, then add the sale counterpart.
  await sql`DROP INDEX IF EXISTS invoices_open_deposit_idx`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS invoices_open_deposit_vs_idx ON invoices (ltrim(variable_symbol, '0'), price_currency) WHERE status = 'unpaid' AND type = 'deposit'`.execute(
    db,
  )
  await sql`CREATE INDEX IF NOT EXISTS invoices_open_sale_vs_idx ON invoices (ltrim(variable_symbol, '0'), price_currency) WHERE status = 'unpaid' AND type = 'sale'`.execute(
    db,
  )
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await sql`DROP INDEX IF EXISTS items_visible_category_idx`.execute(db)
  await sql`DROP INDEX IF EXISTS items_visible_end_idx`.execute(db)
  await sql`DROP INDEX IF EXISTS items_visible_facets_idx`.execute(db)
  await sql`DROP INDEX IF EXISTS notifications_unread_idx`.execute(db)
  await sql`DROP INDEX IF EXISTS invoices_open_deposit_vs_idx`.execute(db)
  await sql`DROP INDEX IF EXISTS invoices_open_sale_vs_idx`.execute(db)
  // Restore the original bare-column deposit index (matches migration 018).
  await sql`CREATE INDEX IF NOT EXISTS invoices_open_deposit_idx ON invoices (variable_symbol, price_currency) WHERE status = 'unpaid' AND type = 'deposit'`.execute(
    db,
  )
}
