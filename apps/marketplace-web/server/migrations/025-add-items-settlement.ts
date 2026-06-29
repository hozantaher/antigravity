import { type Kysely, sql } from 'kysely'

// Sale-settlement (the sale-settlement domain): the durable link + completion marker for a winner's
// final-price payment. No new money table — the invoice itself is a row in the shared `invoices`
// table with type='sale'; only the item→invoice link and the "sale completed" stamp live here.
//   settled_at             — the "sale completed" stamp (mirrors winner_emailed_at); set once, under
//                            a WHERE settled_at IS NULL CAS so completion side-effects fire once.
//   settlement_invoice_id  — item → its sale invoice (FK, ON DELETE SET NULL so deleting the invoice
//                            doesn't cascade-delete the item).
// The partial unique index enforces at most ONE live sale invoice per item — the backstop behind the
// claim CAS in ensureOpenSaleInvoice (charge-once invariant I1).

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable('items')
    .addColumn('settled_at', 'timestamptz')
    .addColumn('settlement_invoice_id', 'text', col => col.references('invoices.id').onDelete('set null'))
    .execute()

  // At most one non-null sale-invoice link per item. A canceled/cleared link (SET NULL) frees the
  // slot, so a re-settlement after a manual cancel can claim a fresh invoice.
  await sql`CREATE UNIQUE INDEX items_settlement_invoice_uidx ON items (settlement_invoice_id) WHERE settlement_invoice_id IS NOT NULL`.execute(
    db,
  )
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropIndex('items_settlement_invoice_uidx').ifExists().execute()
  await db.schema.alterTable('items').dropColumn('settlement_invoice_id').dropColumn('settled_at').execute()
}
