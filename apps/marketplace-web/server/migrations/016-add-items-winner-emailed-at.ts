import { sql, type Kysely } from 'kysely'

// Idempotency marker for the close-auctions job's winner e-mail: set once the mail
// is enqueued so a crash/overlap never double-sends. Backfilled for already-sold
// rows so existing winners (and seed fixtures) aren't e-mailed on first deploy —
// only auctions closed after this migration trigger the mail.
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.alterTable('items').addColumn('winner_emailed_at', 'timestamptz').execute()
  await sql`
    update items set winner_emailed_at = coalesce(updated, created)
    where sold = true and winner is not null
  `.execute(db)
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.alterTable('items').dropColumn('winner_emailed_at').execute()
}
