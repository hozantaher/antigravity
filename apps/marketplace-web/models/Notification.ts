// An in-app notification for a user, raised by a key event on a listing they care about. Three event
// types reach a user in-app: they won an auction, they were outbid, or a question they asked was
// answered. A dedupeKey makes raising the same event twice a no-op (the badge never lies). Dates are
// epoch-ms numbers (the FE/mapper contract). See features/platform/notifications.
export type NotificationType = 'win' | 'outbid' | 'answer'

export interface Notification {
  id: string
  userId: string
  type: NotificationType
  itemId?: string
  title: string
  dedupeKey: string
  readAt?: number // epoch millis; absent = unread
  created: number // epoch millis
}

// Repo input — the recipient + dedupeKey are server-derived from the event, never client-supplied.
export interface NewNotification {
  userId: string
  type: NotificationType
  itemId?: string
  title: string
  dedupeKey: string
}

export const isNotificationRead = (n: Pick<Notification, 'readAt'>): boolean => n.readAt != null

// Pure builders: one per key event. Each derives the recipient + a stable dedupeKey so re-raising the
// same event (an overlapping close sweep, a retried request) collapses to one notification. Kept pure
// so the wiring sites stay thin and the mapping is unit-tested in isolation.
export const winNotification = (itemId: string, winnerId: string, title: string): NewNotification => ({
  userId: winnerId,
  type: 'win',
  itemId,
  title,
  dedupeKey: `win:${itemId}`, // one win per item
})

export const outbidNotification = (itemId: string, outbidUserId: string, title: string): NewNotification => ({
  userId: outbidUserId,
  type: 'outbid',
  itemId,
  title,
  dedupeKey: `outbid:${itemId}:${outbidUserId}`, // one standing "you're outbid" per (item,user)
})

export const answerNotification = (
  questionId: string,
  askerId: string,
  itemId: string,
  title: string,
): NewNotification => ({
  userId: askerId,
  type: 'answer',
  itemId,
  title,
  dedupeKey: `answer:${questionId}`, // one notification per answered question
})
