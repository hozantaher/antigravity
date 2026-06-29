import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createError } from 'h3'
import { makeEvent } from '../../setup/server'

import invoicesHandler from '~/server/api/admin/user/[id]/invoices.get'
import { listForUserPage } from '~/server/repos/invoiceRepo'

vi.mock('~/server/repos/invoiceRepo', () => ({ listForUserPage: vi.fn() }))

const requireAdminMock = () => (globalThis as unknown as { requireAdmin: ReturnType<typeof vi.fn> }).requireAdmin

beforeEach(() => vi.clearAllMocks())

describe('GET /api/admin/user/:id/invoices', () => {
  it('lists invoices for the user with the default page size of 10', async () => {
    const page = { items: [], total: 0, page: 1, pageSize: 10 }
    vi.mocked(listForUserPage).mockResolvedValue(page as never)
    const result = await invoicesHandler(makeEvent({ params: { id: 'u1' } }) as never)
    expect(result).toBe(page)
    expect(listForUserPage).toHaveBeenCalledWith('u1', expect.objectContaining({ pageSize: 10 }))
  })

  it('honours an explicit page and pageSize from the query', async () => {
    vi.mocked(listForUserPage).mockResolvedValue({ items: [] } as never)
    await invoicesHandler(makeEvent({ params: { id: 'u2' }, query: { page: '3', pageSize: '5' } }) as never)
    expect(listForUserPage).toHaveBeenCalledWith('u2', expect.objectContaining({ page: 3, pageSize: 5, offset: 10 }))
  })

  it('propagates the admin gate rejection without touching the repo', async () => {
    requireAdminMock().mockRejectedValue(createError({ statusCode: 403 }))
    await expect(invoicesHandler(makeEvent({ params: { id: 'u1' } }) as never)).rejects.toMatchObject({
      statusCode: 403,
    })
    expect(listForUserPage).not.toHaveBeenCalled()
  })
})
