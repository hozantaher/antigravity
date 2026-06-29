import { type Kysely, sql } from 'kysely'

export const up = async (db: Kysely<unknown>): Promise<void> => {
  // 018 stamped every pre-existing row type='deposit'. Rows that predate the deposit
  // flow carry no variable symbol — re-type them so the deposit endpoints can't adopt
  // a legacy invoice (and charge its arbitrary amount) as "the deposit".
  await sql`UPDATE invoices SET type = 'invoice' WHERE variable_symbol IS NULL`.execute(db)
  await sql`ALTER TABLE invoices ALTER COLUMN type SET DEFAULT 'invoice'`.execute(db)

  // The VS travels interbank as a NUMBER (CERTIS/ABO) — leading zeros don't survive
  // the round trip, so never generate them. Existing zero-led values stay valid
  // because matching is zero-insensitive (ltrim) on both sides.
  await sql`
    CREATE OR REPLACE FUNCTION generate_deposit_vs() RETURNS text AS $$
    DECLARE
      candidate text;
      attempts int := 0;
    BEGIN
      LOOP
        candidate := (floor(random() * 9000000000) + 1000000000)::bigint::text;
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
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
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
  await sql`ALTER TABLE invoices ALTER COLUMN type SET DEFAULT 'deposit'`.execute(db)
  await sql`UPDATE invoices SET type = 'deposit' WHERE type = 'invoice'`.execute(db)
}
