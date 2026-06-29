import { type Kysely, sql } from 'kysely'

// Backfill loops row-by-row because a single
// `UPDATE users SET deposit_vs = generate_deposit_vs() WHERE deposit_vs IS NULL`
// reads one snapshot, so two rows could draw the same candidate. Per-row
// UPDATE lets the next PERFORM see prior writes.

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await sql`
    CREATE OR REPLACE FUNCTION generate_deposit_vs() RETURNS text AS $$
    DECLARE
      candidate text;
      attempts int := 0;
    BEGIN
      LOOP
        candidate := lpad((floor(random() * 10000000000))::bigint::text, 10, '0');
        PERFORM 1 FROM users WHERE deposit_vs = candidate;
        IF NOT FOUND THEN
          RETURN candidate;
        END IF;
        attempts := attempts + 1;
        IF attempts > 20 THEN
          RAISE EXCEPTION 'generate_deposit_vs: failed to allocate unique value after % attempts', attempts;
        END IF;
      END LOOP;
    END;
    $$ LANGUAGE plpgsql VOLATILE;
  `.execute(db)

  await db.schema.alterTable('users').addColumn('deposit_vs', 'text').execute()

  await sql`
    DO $$
    DECLARE
      r record;
    BEGIN
      FOR r IN SELECT id FROM users WHERE deposit_vs IS NULL LOOP
        UPDATE users SET deposit_vs = generate_deposit_vs() WHERE id = r.id;
      END LOOP;
    END;
    $$;
  `.execute(db)

  await sql`ALTER TABLE users ALTER COLUMN deposit_vs SET NOT NULL`.execute(db)
  await sql`ALTER TABLE users ALTER COLUMN deposit_vs SET DEFAULT generate_deposit_vs()`.execute(db)
  await sql`ALTER TABLE users ADD CONSTRAINT users_deposit_vs_format_chk CHECK (deposit_vs ~ '^[0-9]{10}$')`.execute(db)
  await db.schema.createIndex('users_deposit_vs_uniq').on('users').column('deposit_vs').unique().execute()

  await db.schema
    .alterTable('invoices')
    .addColumn('fakturoid_id', 'integer')
    .addColumn('variable_symbol', 'text')
    .addColumn('iban', 'text')
    .addColumn('type', 'text', col => col.notNull().defaultTo('deposit'))
    .addColumn('fakturoid_paid_at', 'timestamptz')
    .execute()

  // Fio matching looks payments up by (VS, currency) across open deposit invoices.
  await sql`
    CREATE INDEX invoices_open_deposit_idx ON invoices (variable_symbol, price_currency)
    WHERE status = 'unpaid' AND type = 'deposit'
  `.execute(db)

  // Every Fio movement ever seen (dedupe + audit). The composite PK doubles as the
  // idempotency claim: only the run that inserts a row processes the payment.
  await db.schema
    .createTable('fio_payments')
    .addColumn('account', 'text', col => col.notNull().check(sql`account IN ('CZK', 'EUR')`))
    .addColumn('fio_id', 'bigint', col => col.notNull())
    .addColumn('amount', sql`numeric(20, 2)`, col => col.notNull())
    .addColumn('currency', 'text', col => col.notNull())
    .addColumn('vs', 'text')
    .addColumn('counter_account', 'text')
    .addColumn('counter_name', 'text')
    .addColumn('message', 'text')
    .addColumn('paid_on', 'timestamptz', col => col.notNull())
    .addColumn('matched_invoice_id', 'text', col => col.references('invoices.id').onDelete('set null'))
    .addColumn('status', 'text', col => col.notNull().defaultTo('unmatched'))
    .addColumn('raw', 'jsonb', col => col.notNull())
    .addColumn('created', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('fio_payments_pk', ['account', 'fio_id'])
    .execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('fio_payments').ifExists().execute()
  await sql`DROP INDEX IF EXISTS invoices_open_deposit_idx`.execute(db)
  await db.schema
    .alterTable('invoices')
    .dropColumn('fakturoid_id')
    .dropColumn('variable_symbol')
    .dropColumn('iban')
    .dropColumn('type')
    .dropColumn('fakturoid_paid_at')
    .execute()
  await db.schema.dropIndex('users_deposit_vs_uniq').ifExists().execute()
  await sql`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_deposit_vs_format_chk`.execute(db)
  await db.schema.alterTable('users').dropColumn('deposit_vs').execute()
  await sql`DROP FUNCTION IF EXISTS generate_deposit_vs()`.execute(db)
}
