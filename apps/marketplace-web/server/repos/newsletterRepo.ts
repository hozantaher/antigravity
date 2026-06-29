import { sql } from 'kysely'
import { db } from '../utils/db'

// Newsletter cadence data access (§12). The cron runs every 2 days; a user is "due"
// only ≥7 days after their last send, so weekly-per-user sends stagger across runs.

export interface DueNewsletterUser {
  id: string
  email: string
  languageCode: string | null
}

export const listDueNewsletterUsers = (cutoffMs: number, limit: number): Promise<DueNewsletterUser[]> =>
  db
    .selectFrom('users')
    .select(['id', 'email', 'languageCode'])
    .where('newsletter', '=', true)
    .where('emailVerified', '=', true)
    .where('deletedAt', 'is', null)
    .where(eb => eb.or([eb('newsletterLastSentAt', 'is', null), eb('newsletterLastSentAt', '<', new Date(cutoffMs))]))
    .orderBy(sql`newsletter_last_sent_at asc nulls first`) // never-sent first
    .limit(limit)
    .execute()

/**
 * Claim a send by stamping `newsletter_last_sent_at = now()` only while the user is
 * still due (CAS). A losing concurrent run gets `false` and skips → no double-send.
 */
export const claimNewsletterSend = async (userId: string, cutoffMs: number): Promise<boolean> => {
  const res = await db
    .updateTable('users')
    .set({ newsletterLastSentAt: new Date() })
    .where('id', '=', userId)
    .where(eb => eb.or([eb('newsletterLastSentAt', 'is', null), eb('newsletterLastSentAt', '<', new Date(cutoffMs))]))
    .executeTakeFirst()
  return Number(res.numUpdatedRows ?? 0) > 0
}

export const setNewsletterEnabled = async (userId: string, enabled: boolean): Promise<void> => {
  await db.updateTable('users').set({ newsletter: enabled }).where('id', '=', userId).execute()
}
