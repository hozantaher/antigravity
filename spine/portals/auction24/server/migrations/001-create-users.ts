import { type Kysely, sql } from 'kysely'

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('users')
    // id = Firebase UID for real users; arbitrary for seed-only rows.
    .addColumn('id', 'text', col => col.primaryKey())
    .addColumn('auth_type', 'text', col => col.notNull().check(sql`auth_type IN ('email', 'facebook', 'google')`))
    .addColumn('full_name', 'text', col => col.notNull())
    .addColumn('email', 'text', col => col.notNull())
    .addColumn('company_name', 'text')
    .addColumn('company_vat_number', 'text')
    .addColumn('company_id_number', 'text')
    .addColumn('bank_account', 'text')
    .addColumn('phone', 'text')
    .addColumn('address', 'jsonb')
    .addColumn('vat', 'numeric')
    .addColumn('roles', sql`text[]`, col => col.notNull().defaultTo(sql`ARRAY['user']::text[]`))
    .addColumn('deposit_balance_amount', sql`numeric(20, 2)`)
    .addColumn('deposit_balance_currency', 'text')
    .addColumn('invoice_due_days', 'integer', col => col.notNull().defaultTo(14))
    .addColumn('favorite_ids', sql`text[]`, col => col.notNull().defaultTo(sql`'{}'::text[]`))
    .addColumn('language_code', 'text')
    .addColumn('newsletter', 'boolean', col => col.notNull().defaultTo(false))
    .addColumn('email_verified', 'boolean', col => col.notNull().defaultTo(false))
    .addColumn('deposit_required', 'boolean', col => col.notNull().defaultTo(true))
    .addColumn('fakturoid_id', 'integer')
    .addColumn('banned', 'boolean', col => col.notNull().defaultTo(false))
    // Revocation cutoff: getSessionUser rejects tokens with iat <= this. Default
    // 'epoch' so fresh-login tokens pass (now() would reject them immediately).
    .addColumn('tokens_valid_after', sql`timestamptz`, col => col.notNull().defaultTo(sql`'epoch'::timestamptz`))
    .addColumn('created', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema.createIndex('users_email_idx').on('users').column('email').execute()
  await db.schema.createIndex('users_roles_gin_idx').on('users').using('gin').column('roles').execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('users').ifExists().execute()
}
