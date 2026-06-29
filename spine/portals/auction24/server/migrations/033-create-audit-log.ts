import { type Kysely, sql } from 'kysely'

// Append-only trail of sensitive / irreversible admin actions (item delete, user delete, ban,
// grant-admin, rating hide, reconciliation dismiss). Answers "who changed what, when" — which the
// app could not answer before. before/after hold compact snapshots, not full rows.
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema
    .createTable('audit_log')
    .addColumn('id', 'bigserial', col => col.primaryKey())
    // Nullable: a system/cron actor has no admin user id.
    .addColumn('actor_id', 'text', col => col.references('users.id').onDelete('set null'))
    .addColumn('action', 'text', col => col.notNull())
    .addColumn('entity', 'text', col => col.notNull())
    .addColumn('entity_id', 'text', col => col.notNull())
    .addColumn('before', 'jsonb')
    .addColumn('after', 'jsonb')
    .addColumn('at', 'timestamptz', col => col.notNull().defaultTo(sql`now()`))
    .addColumn('ip', 'text')
    .execute()

  await db.schema.createIndex('audit_log_entity_idx').on('audit_log').columns(['entity', 'entity_id']).execute()
  await db.schema.createIndex('audit_log_at_idx').on('audit_log').columns(['at desc']).execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.dropTable('audit_log').ifExists().execute()
}
