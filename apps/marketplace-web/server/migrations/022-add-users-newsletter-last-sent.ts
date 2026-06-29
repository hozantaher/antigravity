import type { Kysely } from 'kysely'

// Per-user newsletter cadence (§12): the cron runs every 2 days and only emails users
// due (≥7 days since this timestamp), so weekly-per-user sends stagger naturally.

export const up = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.alterTable('users').addColumn('newsletter_last_sent_at', 'timestamptz').execute()
}

export const down = async (db: Kysely<unknown>): Promise<void> => {
  await db.schema.alterTable('users').dropColumn('newsletter_last_sent_at').execute()
}
