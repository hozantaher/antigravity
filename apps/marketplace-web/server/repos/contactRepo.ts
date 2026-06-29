import { randomBytes } from 'node:crypto'
import type { ContactMessage, NewContactMessage, Paginated } from '~/models'
import { db } from '../utils/db'
import { rowToContactMessage } from './mappers'
import { paginate, type PageParams } from '../utils/pagination'

const newContactId = (): string => `c${Date.now().toString(36)}${randomBytes(4).toString('hex')}`

export const createContactMessage = async (input: NewContactMessage): Promise<ContactMessage> => {
  const row = await db
    .insertInto('contactMessages')
    .values({
      id: newContactId(),
      kind: input.kind,
      name: input.name ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      location: input.location ?? null,
      vehicle: input.vehicle ?? null,
      message: input.message ?? null,
      itemId: input.itemId ?? null,
      userId: input.userId ?? null,
      offerAmount: input.offerAmount ?? null,
      offerCurrency: input.offerCurrency ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
  return rowToContactMessage(row)
}

// Idempotent: the IS NULL guard means a retried notification never reopens an already-stamped row.
export const markContactNotified = async (id: string): Promise<void> => {
  await db
    .updateTable('contactMessages')
    .set({ notifiedAt: new Date() })
    .where('id', '=', id)
    .where('notifiedAt', 'is', null)
    .execute()
}

export const listContactMessagesPage = (params: PageParams): Promise<Paginated<ContactMessage>> =>
  paginate(
    db.selectFrom('contactMessages'),
    qb => qb.orderBy('created', 'desc').orderBy('id', 'asc'),
    rows => rows.map(rowToContactMessage),
    params,
  )
