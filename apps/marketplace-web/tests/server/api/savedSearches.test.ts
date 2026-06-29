import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createError } from 'h3'
import { makeEvent, setSessionUser } from '../../setup/server'

import listHandler from '~/server/api/saved-searches/index.get'
import createHandler from '~/server/api/saved-searches/index.post'
import patchHandler from '~/server/api/saved-searches/[id].patch'
import deleteHandler from '~/server/api/saved-searches/[id].delete'
import * as repo from '~/server/repos/savedSearchRepo'

vi.mock('~/server/repos/savedSearchRepo', () => ({
  listForUser: vi.fn(),
  countForUser: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}))

const SAVED = { id: 'ss1', userId: 'u1', name: 'BMW', query: {}, alertEnabled: true, createdAt: 1 }

beforeEach(() => {
  vi.clearAllMocks()
  setSessionUser({ id: 'u1', fullName: 'Jan', email: 'jan@x.cz' })
  vi.mocked(repo.listForUser).mockResolvedValue({ items: [SAVED], total: 1, page: 1, pageSize: 10 } as never)
  vi.mocked(repo.countForUser).mockResolvedValue(0)
  vi.mocked(repo.create).mockResolvedValue(SAVED as never)
  vi.mocked(repo.update).mockResolvedValue(SAVED as never)
  vi.mocked(repo.remove).mockResolvedValue(true)
})

describe('GET /api/saved-searches', () => {
  it('lists the session user’s saved searches', async () => {
    const res = await listHandler(makeEvent({ query: { page: '1' } }) as never)
    expect(repo.listForUser).toHaveBeenCalledWith('u1', expect.objectContaining({ page: 1 }))
    expect(res).toMatchObject({ total: 1 })
  })

  it('rejects an anonymous user with 401', async () => {
    ;(globalThis as Record<string, unknown>).requireSession = vi
      .fn()
      .mockRejectedValue(createError({ statusCode: 401 }))
    await expect(listHandler(makeEvent() as never)).rejects.toMatchObject({ statusCode: 401 })
    expect(repo.listForUser).not.toHaveBeenCalled()
  })
})

describe('POST /api/saved-searches', () => {
  it('creates with the session user id and the normalized query', async () => {
    const res = await createHandler(
      makeEvent({ body: { name: '  BMW  ', query: { q: 'bmw', type: 'junk' }, userId: 'attacker' } }) as never,
    )
    // create(id, userId, body): a generated id, the SESSION user id (never the body's), the body
    // whose query was normalized (the unknown type:'junk' facet dropped). The mapper trims the name.
    const [id, userId, body] = vi.mocked(repo.create).mock.calls[0]!
    expect(typeof id).toBe('string')
    expect(userId).toBe('u1')
    expect(body).toMatchObject({ name: '  BMW  ', query: { q: 'bmw' } })
    expect(body.query).not.toHaveProperty('type')
    expect(res).toMatchObject({ id: 'ss1' })
  })

  it('422s an empty/blank name and never persists', async () => {
    await expect(createHandler(makeEvent({ body: { name: '   ', query: {} } }) as never)).rejects.toMatchObject({
      statusCode: 422,
    })
    expect(repo.create).not.toHaveBeenCalled()
  })

  it('409s when the per-user cap is reached', async () => {
    vi.mocked(repo.countForUser).mockResolvedValue(50)
    await expect(createHandler(makeEvent({ body: { name: 'BMW', query: {} } }) as never)).rejects.toMatchObject({
      statusCode: 409,
    })
    expect(repo.create).not.toHaveBeenCalled()
  })

  it('propagates the rate-limit rejection before persisting', async () => {
    ;(globalThis as Record<string, unknown>).enforceRateLimit = vi.fn(() => {
      throw createError({ statusCode: 429 })
    })
    await expect(createHandler(makeEvent({ body: { name: 'BMW', query: {} } }) as never)).rejects.toMatchObject({
      statusCode: 429,
    })
    expect(repo.create).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/saved-searches/[id]', () => {
  it('updates name/alertEnabled scoped to the session user', async () => {
    const res = await patchHandler(makeEvent({ params: { id: 'ss1' }, body: { alertEnabled: false } }) as never)
    expect(repo.update).toHaveBeenCalledWith('ss1', 'u1', { alertEnabled: false })
    expect(res).toMatchObject({ id: 'ss1' })
  })

  it('passes the raw body through (the repo whitelist rejects userId/query)', async () => {
    await patchHandler(makeEvent({ params: { id: 'ss1' }, body: { name: 'X', userId: 'attacker' } }) as never)
    // The handler forwards the body; the mapper (unit-tested) drops userId. Owner scope is the (id,userId) args.
    expect(repo.update).toHaveBeenCalledWith('ss1', 'u1', { name: 'X', userId: 'attacker' })
  })

  it('404s a cross-user / missing id (repo returns undefined)', async () => {
    vi.mocked(repo.update).mockResolvedValue(undefined as never)
    await expect(
      patchHandler(makeEvent({ params: { id: 'other' }, body: { name: 'X' } }) as never),
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('400s a missing id', async () => {
    await expect(patchHandler(makeEvent({ params: {}, body: { name: 'X' } }) as never)).rejects.toMatchObject({
      statusCode: 400,
    })
  })
})

describe('DELETE /api/saved-searches/[id]', () => {
  it('deletes scoped to the session user and returns 204', async () => {
    const event = makeEvent({ params: { id: 'ss1' } })
    const res = await deleteHandler(event as never)
    expect(repo.remove).toHaveBeenCalledWith('ss1', 'u1')
    expect(res).toBeNull()
  })

  it('404s when nothing was deleted (cross-user / gone)', async () => {
    vi.mocked(repo.remove).mockResolvedValue(false)
    await expect(deleteHandler(makeEvent({ params: { id: 'other' } }) as never)).rejects.toMatchObject({
      statusCode: 404,
    })
  })

  it('rejects an anonymous user with 401 before deleting', async () => {
    ;(globalThis as Record<string, unknown>).requireSession = vi
      .fn()
      .mockRejectedValue(createError({ statusCode: 401 }))
    await expect(deleteHandler(makeEvent({ params: { id: 'ss1' } }) as never)).rejects.toMatchObject({
      statusCode: 401,
    })
    expect(repo.remove).not.toHaveBeenCalled()
  })
})
