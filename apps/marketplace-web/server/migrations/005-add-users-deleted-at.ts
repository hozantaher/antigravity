import type { Kysely } from 'kysely'

// Account deletion is a soft-delete: bids.user_id / items.user_id reference users
// with ON DELETE RESTRICT, so the row is kept (anonymized) rather than dropped.
export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.alterTable('users').addColumn('deleted_at', 'timestamptz').execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.alterTable('users').dropColumn('deleted_at').execute()
}
