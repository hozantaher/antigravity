import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { db } from '~/server/utils/db'
import * as repo from '~/server/repos/notificationRepo'

// Integration: notification repo against docker Postgres (:5434). The dedupe (idempotence) and the
// read/unread transitions are real SQL, so they live here. Skipped without POSTGRES_URL.
const RUN = !!process.env.POSTGRES_URL
const USER = 'itest-notif-user'
const OTHER = 'itest-notif-other'

const seedUser = (id: string) =>
  db
    .insertInto('users')
    .values({
      id,
      authType: 'email',
      fullName: `N ${id}`,
      email: `${id}@example.test`,
      emailVerified: true,
      languageCode: 'cz',
    })
    .onConflict(oc => oc.column('id').doNothing())
    .execute()

const cleanup = async () => {
  await db.deleteFrom('notifications').where('userId', 'like', 'itest-notif-%').execute()
  await db.deleteFrom('users').where('id', 'like', 'itest-notif-%').execute()
}

describe.skipIf(!RUN)('notificationRepo (Postgres)', () => {
  beforeAll(async () => {
    await cleanup()
    await seedUser(USER)
    await seedUser(OTHER)
  })
  afterAll(cleanup)
  beforeEach(async () => {
    await db.deleteFrom('notifications').where('userId', 'like', 'itest-notif-%').execute()
  })

  it('createNotification is idempotent on dedupeKey — the same event never doubles', async () => {
    const first = await repo.createNotification({ userId: USER, type: 'win', title: 'BMW', dedupeKey: 'win:itX' })
    const second = await repo.createNotification({ userId: USER, type: 'win', title: 'BMW', dedupeKey: 'win:itX' })
    expect(first?.id).toBeTruthy()
    expect(second).toBeUndefined() // duplicate collapsed to a no-op
    expect(await repo.unreadCount(USER)).toBe(1) // only one row exists
  })

  it('tracks read/unread and the unread badge clears on markRead', async () => {
    const n = await repo.createNotification({ userId: USER, type: 'answer', title: 'Q', dedupeKey: 'answer:q1' })
    expect(await repo.unreadCount(USER)).toBe(1)
    const read = await repo.markRead(n!.id, USER)
    expect(read?.readAt).toBeGreaterThan(0)
    expect(await repo.unreadCount(USER)).toBe(0) // badge cleared
  })

  it('markRead is owner-scoped — another user cannot read-flag your notification', async () => {
    const n = await repo.createNotification({ userId: USER, type: 'win', title: 'X', dedupeKey: 'win:itZ' })
    expect(await repo.markRead(n!.id, OTHER)).toBeUndefined()
    expect(await repo.unreadCount(USER)).toBe(1) // still unread
  })

  it('lists a user’s notifications newest first', async () => {
    await repo.createNotification({ userId: USER, type: 'win', title: 'A', dedupeKey: 'k:a' })
    await repo.createNotification({ userId: USER, type: 'outbid', title: 'B', dedupeKey: 'k:b' })
    const page = await repo.listForUser(USER, { page: 1, pageSize: 50, limit: 50, offset: 0 })
    expect(page.items.map(n => n.title)).toEqual(['B', 'A'])
  })
})
