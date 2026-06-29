import { type Kysely, sql } from 'kysely'

// Indexes backing the paginated list queries (ORDER BY … LIMIT/OFFSET + COUNT).
export const up = async (db: Kysely<unknown>): Promise<void> => {
  // created-desc drives the sold/admin lists and the tie-break in every item order.
  await sql`CREATE INDEX IF NOT EXISTS items_created_idx ON items (created DESC)`.execute(db)
  // Sold list — partial, only the sold rows it scans.
  await sql`CREATE INDEX IF NOT EXISTS items_sold_created_idx ON items (created DESC) WHERE sold`.execute(db)
  // Bid history page: where item_id order by date desc.
  await sql`CREATE INDEX IF NOT EXISTS bids_item_date_idx ON bids (item_id, date DESC)`.execute(db)
  // Per-user invoice list.
  await sql`CREATE INDEX IF NOT EXISTS invoices_user_created_idx ON invoices (user_id, created_date DESC)`.execute(db)
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await sql`DROP INDEX IF EXISTS items_created_idx`.execute(db)
  await sql`DROP INDEX IF EXISTS items_sold_created_idx`.execute(db)
  await sql`DROP INDEX IF EXISTS bids_item_date_idx`.execute(db)
  await sql`DROP INDEX IF EXISTS invoices_user_created_idx`.execute(db)
}
