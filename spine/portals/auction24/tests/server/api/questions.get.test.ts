import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createError } from 'h3'
import { makeEvent } from '../../setup/server'

import publicHandler from '~/server/api/item/[id]/questions.get'
import adminHandler from '~/server/api/admin/questions.get'
import { listQuestionsPage, listAdminQuestionsPage } from '~/server/repos/questionRepo'

vi.mock('~/server/repos/questionRepo', () => ({
  listQuestionsPage: vi.fn(),
  listAdminQuestionsPage: vi.fn(),
}))

const requireAdminMock = () => (globalThis as unknown as { requireAdmin: ReturnType<typeof vi.fn> }).requireAdmin

beforeEach(() => vi.clearAllMocks())

describe('GET /api/item/[id]/questions — public thread', () => {
  // PUBLIC-1 — the public list delegates to the published-only repo read (moderation boundary). The
  // repo's WHERE status='published' is what excludes pending/hidden; this proves the handler routes
  // through it (never the admin all-statuses read) and returns what it gets.
  it('delegates to the published-only repo read, not the admin all-statuses read', async () => {
    vi.mocked(listQuestionsPage).mockResolvedValue({
      items: [{ id: 'q1', itemId: 'itm1', body: 'Hi?', status: 'published', created: 1 }],
      total: 1,
      page: 1,
      pageSize: 20,
    } as never)
    const res = (await publicHandler(makeEvent({ params: { id: 'itm1' } }) as never)) as {
      items: unknown[]
      total: number
    }
    expect(listQuestionsPage).toHaveBeenCalledWith('itm1', expect.objectContaining({ pageSize: 20 }))
    expect(res.total).toBe(1)
    expect(listAdminQuestionsPage).not.toHaveBeenCalled()
  })

  // PUBLIC-PROJECTION — the response is PublicQuestion: the asker's userId and the answering admin
  // (answeredBy) are stripped so the public thread never leaks identities.
  it('projects rows to PublicQuestion (no userId / answeredBy leak)', async () => {
    vi.mocked(listQuestionsPage).mockResolvedValue({
      items: [
        {
          id: 'q1',
          itemId: 'itm1',
          userId: 'secret-asker',
          body: 'Is the VIN ok?',
          answer: 'Yes.',
          answeredBy: 'admin-77',
          status: 'published',
          created: 1,
          answeredAt: 2,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    } as never)
    const res = (await publicHandler(makeEvent({ params: { id: 'itm1' } }) as never)) as unknown as {
      items: Record<string, unknown>[]
    }
    const row = res.items[0]!
    expect(row).toEqual({
      id: 'q1',
      itemId: 'itm1',
      body: 'Is the VIN ok?',
      answer: 'Yes.',
      status: 'published',
      created: 1,
      answeredAt: 2,
    })
    expect(row).not.toHaveProperty('userId')
    expect(row).not.toHaveProperty('answeredBy')
  })

  // PUBLIC-RATE — the anonymous read is IP-rate-limited (60/min); the throw propagates.
  it('is rate-limited per IP and does not query when throttled', async () => {
    const spy = vi.fn()
    ;(globalThis as Record<string, unknown>).enforceRateLimit = spy
    vi.mocked(listQuestionsPage).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 } as never)
    await publicHandler(makeEvent({ params: { id: 'itm1' } }) as never)
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ bucket: 'questions:list', limit: 60, windowMs: 60_000 }),
    )
    ;(globalThis as Record<string, unknown>).enforceRateLimit = vi.fn(() => {
      throw createError({ statusCode: 429 })
    })
    vi.mocked(listQuestionsPage).mockClear()
    await expect(publicHandler(makeEvent({ params: { id: 'itm1' } }) as never)).rejects.toMatchObject({
      statusCode: 429,
    })
    expect(listQuestionsPage).not.toHaveBeenCalled()
  })

  // PUBLIC-2 — pagination bounds: ?page / ?pageSize are parsed and clamped (default 20, max 100).
  it('parses ?page and clamps ?pageSize to the 100 max', async () => {
    vi.mocked(listQuestionsPage).mockResolvedValue({ items: [], total: 0, page: 3, pageSize: 100 } as never)
    await publicHandler(makeEvent({ params: { id: 'itm1' }, query: { page: '3', pageSize: '500' } }) as never)
    expect(listQuestionsPage).toHaveBeenCalledWith('itm1', expect.objectContaining({ page: 3, pageSize: 100 }))
  })

  // PUBLIC-3 — an item with no published questions yields an empty page, not an error.
  it('returns an empty page when there are no published questions', async () => {
    vi.mocked(listQuestionsPage).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 } as never)
    const res = (await publicHandler(makeEvent({ params: { id: 'itm1' } }) as never)) as { items: unknown[] }
    expect(res.items).toEqual([])
  })
})

describe('GET /api/admin/questions — moderation queue', () => {
  // requireAdmin is a fresh vi.fn() per test (resolves undefined → admin gate passes); the list
  // handler ignores the admin id, so the success cases need no explicit mockResolvedValue.

  // ADMIN-LIST-1 — authz: a non-admin is rejected and the all-statuses read never runs. This is the
  // guard that keeps pending/hidden content out of non-admin hands.
  it('rejects a non-admin with 403 and does not query', async () => {
    requireAdminMock().mockRejectedValue(createError({ statusCode: 403 }))
    await expect(adminHandler(makeEvent() as never)).rejects.toMatchObject({ statusCode: 403 })
    expect(listAdminQuestionsPage).not.toHaveBeenCalled()
  })

  // ADMIN-LIST-2 — ?itemId scopes the queue to one listing (editor's Questions tab).
  it('passes the itemId filter through to the all-statuses read', async () => {
    vi.mocked(listAdminQuestionsPage).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 } as never)
    await adminHandler(makeEvent({ query: { itemId: 'itm9' } }) as never)
    expect(listAdminQuestionsPage).toHaveBeenCalledWith(expect.objectContaining({ pageSize: 20 }), { itemId: 'itm9' })
  })

  // ADMIN-LIST-3 — a missing / non-string itemId becomes undefined (unscoped global queue).
  it('passes itemId: undefined when no itemId is given', async () => {
    vi.mocked(listAdminQuestionsPage).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 } as never)
    await adminHandler(makeEvent() as never)
    expect(listAdminQuestionsPage).toHaveBeenCalledWith(expect.anything(), { itemId: undefined })

    vi.mocked(listAdminQuestionsPage).mockClear()
    await adminHandler(makeEvent({ query: { itemId: ['a', 'b'] as unknown as string } }) as never)
    expect(listAdminQuestionsPage).toHaveBeenCalledWith(expect.anything(), { itemId: undefined })
  })
})
