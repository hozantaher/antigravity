import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createError } from 'h3'
import { makeEvent, setSessionUser } from '../../setup/server'

import listH from '~/server/api/notifications/index.get'
import readH from '~/server/api/notifications/[id]/read.post'
import { notifyWin, notifyOutbid, notifyAnswer } from '~/server/utils/notify'
import * as repo from '~/server/repos/notificationRepo'

vi.mock('~/server/repos/notificationRepo', () => ({
  createNotification: vi.fn(),
  listForUser: vi.fn(),
  unreadCount: vi.fn(),
  markRead: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  setSessionUser({ id: 'u1', fullName: 'U', email: 'u@x.cz' })
  vi.mocked(repo.createNotification).mockResolvedValue(undefined as never)
  vi.mocked(repo.listForUser).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 } as never)
  vi.mocked(repo.unreadCount).mockResolvedValue(3)
  vi.mocked(repo.markRead).mockResolvedValue({ id: 'n1', readAt: 1 } as never)
})

// key-events: the three user-bound events each reach the in-app store via the notify layer.
describe('key-event notifications reach the in-app store', () => {
  it('win → a win notification for the winner', async () => {
    await notifyWin('it1', 'u-win', 'BMW')
    expect(repo.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'win', userId: 'u-win', dedupeKey: 'win:it1' }),
    )
  })

  it('outbid → an outbid notification for whoever was outbid', async () => {
    await notifyOutbid('it1', 'u-old', 'BMW')
    expect(repo.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'outbid', userId: 'u-old', dedupeKey: 'outbid:it1:u-old' }),
    )
  })

  it('answer → an answer notification for the asker', async () => {
    await notifyAnswer('q9', 'u-ask', 'it1', 'BMW')
    expect(repo.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'answer', userId: 'u-ask', dedupeKey: 'answer:q9' }),
    )
  })

  it('a failing store never throws into the flow that raised it (best-effort)', async () => {
    vi.mocked(repo.createNotification).mockRejectedValue(new Error('db down'))
    await expect(notifyWin('it1', 'u-win', 'BMW')).resolves.toBeUndefined()
  })
})

describe('GET /api/notifications', () => {
  it('returns the session user list plus the unread badge count', async () => {
    const res = await listH(makeEvent({ query: {} }) as never)
    expect(repo.listForUser).toHaveBeenCalledWith('u1', expect.anything())
    expect(res).toMatchObject({ unread: 3 })
  })

  it('rejects an anonymous user with 401', async () => {
    ;(globalThis as Record<string, unknown>).requireSession = vi
      .fn()
      .mockRejectedValue(createError({ statusCode: 401 }))
    await expect(listH(makeEvent() as never)).rejects.toMatchObject({ statusCode: 401 })
  })
})

describe('POST /api/notifications/:id/read', () => {
  it('marks one read, scoped to the session user', async () => {
    await readH(makeEvent({ params: { id: 'n1' } }) as never)
    expect(repo.markRead).toHaveBeenCalledWith('n1', 'u1')
  })

  it('404s when no row matched (wrong id or another user’s)', async () => {
    vi.mocked(repo.markRead).mockResolvedValue(undefined as never)
    await expect(readH(makeEvent({ params: { id: 'x' } }) as never)).rejects.toMatchObject({ statusCode: 404 })
  })
})
