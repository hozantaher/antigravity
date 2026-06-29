import { type Kysely, sql } from 'kysely'

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .alterTable('invoices')
    .addColumn('stripe_session_id', 'text')
    .addColumn('stripe_payment_intent', 'text')
    .execute()

  // One Checkout session settles at most one invoice; the webhook also uses the
  // session id to tell a replayed settle from an unmatched charge.
  await sql`
    CREATE UNIQUE INDEX invoices_stripe_session_uniq ON invoices (stripe_session_id)
    WHERE stripe_session_id IS NOT NULL
  `.execute(db)

  // Stripe webhook event dedupe: the INSERT is the idempotency claim.
  await db.schema
    .createTable('processed_stripe_events')
    .addColumn('event_id', 'text', col => col.primaryKey())
    .addColumn('type', 'text', col => col.notNull())
    .addColumn('processed_at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createIndex('processed_stripe_events_processed_at_idx')
    .on('processed_stripe_events')
    .column('processed_at')
    .execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('processed_stripe_events').ifExists().execute()
  await sql`DROP INDEX IF EXISTS invoices_stripe_session_uniq`.execute(db)
  await db.schema.alterTable('invoices').dropColumn('stripe_session_id').dropColumn('stripe_payment_intent').execute()
}
