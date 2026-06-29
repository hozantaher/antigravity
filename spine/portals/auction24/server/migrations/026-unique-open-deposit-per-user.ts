import { sql, type Kysely } from 'kysely'

// Dedup guard: at most one OPEN deposit invoice per user per currency. Two concurrent deposit
// initiations (a double-clicked transfer, or transfer racing card checkout) used to each insert a
// separate unpaid invoice with the same VS — duplicate Fakturoid proformas / payable Stripe
// sessions. recordDepositInvoice now ON CONFLICT DO NOTHING against this index and reuses the
// winner. (deposit_vs is unique per user, so this is equivalent to the (variable_symbol,
// price_currency) Fio-lookup index from migration 018, which stays for the settle path.)

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await sql`
    CREATE UNIQUE INDEX invoices_open_deposit_user_idx ON invoices (user_id, price_currency)
    WHERE status = 'unpaid' AND type = 'deposit'
  `.execute(db)
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await sql`DROP INDEX IF EXISTS invoices_open_deposit_user_idx`.execute(db)
}
