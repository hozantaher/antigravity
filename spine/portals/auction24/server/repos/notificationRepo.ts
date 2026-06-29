import type { NewNotification, Notification, Paginated } from '~/models'
import { db } from '../utils/db'
import { paginate, type PageParams } from '../utils/pagination'

interface NotificationRow {
  id: string
  userId: string
  type: string
  itemId: string | null
  title: string
  dedupeKey: string
  readAt: Date | null
  created: Date
}

const rowToNotification = (r: NotificationRow): Notification => ({
  id: r.id,
  userId: r.userId,
  type: r.type as Notification['type'],
  itemId: r.itemId ?? undefined,
  title: r.title,
  dedupeKey: r.dedupeKey,
  readAt: r.readAt ? r.readAt.getTime() : undefined,
  created: r.created.getTime(),
})

// Idempotent create: the UNIQUE(dedupe_key) turns a re-raised event into a no-op. onConflict doNothing
// returns no row on a duplicate → undefined, so callers (best-effort emit sites) can ignore the result.
export const createNotification = async (input: NewNotification): Promise<Notification | undefined> => {
  const row = await db
    .insertInto('notifications')
    .values({
      userId: input.userId,
      type: input.type,
      itemId: input.itemId ?? null,
      title: input.title,
      dedupeKey: input.dedupeKey,
    })
    .onConflict(oc => oc.column('dedupeKey').doNothing())
    .returningAll()
    .executeTakeFirst()
  return row ? rowToNotification(row as NotificationRow) : undefined
}

// The recipient's notifications, newest first, paginated.
export const listForUser = (userId: string, params: PageParams): Promise<Paginated<Notification>> =>
  paginate(
    db.selectFrom('notifications').where('userId', '=', userId),
    qb => qb.orderBy('created', 'desc').orderBy('id', 'desc'),
    rows => rows.map(r => rowToNotification(r as NotificationRow)),
    params,
  )

// Count of unread notifications — powers the badge.
export const unreadCount = async (userId: string): Promise<number> => {
  const row = await db
    .selectFrom('notifications')
    .select(eb => eb.fn.countAll<string>().as('n'))
    .where('userId', '=', userId)
    .where('readAt', 'is', null)
    .executeTakeFirst()
  return row ? Number(row.n) : 0
}

// Mark one notification read, scoped to its owner (a crafted id can't read-flag someone else's row).
// Returns the updated notification, or undefined when no row matched (wrong id/owner, drives a 404).
export const markRead = async (id: string, userId: string): Promise<Notification | undefined> => {
  if (!/^\d+$/.test(id)) return undefined
  const row = await db
    .updateTable('notifications')
    .set({ readAt: new Date() })
    .where('id', '=', id)
    .where('userId', '=', userId)
    .returningAll()
    .executeTakeFirst()
  return row ? rowToNotification(row as NotificationRow) : undefined
}

// Mark every unread notification read for a user; returns how many were flipped.
export const markAllRead = async (userId: string): Promise<number> => {
  const res = await db
    .updateTable('notifications')
    .set({ readAt: new Date() })
    .where('userId', '=', userId)
    .where('readAt', 'is', null)
    .executeTakeFirst()
  return Number(res.numUpdatedRows ?? 0)
}
