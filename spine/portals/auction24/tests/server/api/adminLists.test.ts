import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createError } from 'h3'
import { makeEvent } from '../../setup/server'

import itemsHandler from '~/server/api/admin/items.get'
import usersHandler from '~/server/api/admin/users.get'
import { listAdminItemsPage } from '~/server/repos/itemRepo'
import { listAdminUsersPage } from '~/server/repos/userRepo'

vi.mock('~/server/repos/itemRepo', () => ({ listAdminItemsPage: vi.fn() }))
vi.mock('~/server/repos/userRepo', () => ({ listAdminUsersPage: vi.fn() }))

const requireAdminMock = () => (globalThis as unknown as { requireAdmin: ReturnType<typeof vi.fn> }).requireAdmin

beforeEach(() => vi.clearAllMocks())

describe('GET /api/admin/items', () => {
  it.each([
    ['hidden', 'hidden'],
    ['all', 'all'],
    ['weird', 'visible'],
    [undefined, 'visible'],
  ])('clamps visibility %s to %s', async (input, expected) => {
    vi.mocked(listAdminItemsPage).mockResolvedValue({ items: [] } as never)
    await itemsHandler(makeEvent({ query: { visibility: input, q: 'bmw' } }) as never)
    expect(listAdminItemsPage).toHaveBeenCalledWith(
      { q: 'bmw', visibility: expected },
      expect.objectContaining({ pageSize: 20 }),
    )
  })

  it('omits q from the filter when it is not a string', async () => {
    vi.mocked(listAdminItemsPage).mockResolvedValue({ items: [] } as never)
    await itemsHandler(makeEvent({ query: { visibility: 'all' } }) as never)
    expect(listAdminItemsPage).toHaveBeenCalledWith(
      { q: undefined, visibility: 'all' },
      expect.objectContaining({ pageSize: 20 }),
    )
  })

  it('propagates the admin gate rejection', async () => {
    requireAdminMock().mockRejectedValue(createError({ statusCode: 403 }))
    await expect(itemsHandler(makeEvent() as never)).rejects.toMatchObject({ statusCode: 403 })
    expect(listAdminItemsPage).not.toHaveBeenCalled()
  })
})

describe('GET /api/admin/users', () => {
  it('passes the optional search term and pageSize 20', async () => {
    vi.mocked(listAdminUsersPage).mockResolvedValue({ items: [] } as never)
    await usersHandler(makeEvent({ query: { q: 'jan' } }) as never)
    expect(listAdminUsersPage).toHaveBeenCalledWith({ q: 'jan' }, expect.objectContaining({ pageSize: 20 }))
  })

  it('passes undefined when no search term', async () => {
    vi.mocked(listAdminUsersPage).mockResolvedValue({ items: [] } as never)
    await usersHandler(makeEvent() as never)
    expect(listAdminUsersPage).toHaveBeenCalledWith({ q: undefined }, expect.anything())
  })
})
