import type { Kysely } from 'kysely'

// Snapshot the payer's billing address onto the sale invoice at settlement time. A snapshot (not a
// live join to users.address) so the document keeps the address as it was when paid, even if the user
// later edits their profile — the accounting record must not drift.
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.alterTable('invoices').addColumn('billing_address', 'jsonb').execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.alterTable('invoices').dropColumn('billing_address').execute()
}
