import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeEvent } from '../../setup/server'

import deleteItemH from '~/server/api/admin/item/[id].delete'
import putItemH from '~/server/api/admin/item/[id].put'
import createItemH from '~/server/api/admin/item/index.post'
import userGetH from '~/server/api/admin/user/[id].get'
import userInvoicesH from '~/server/api/admin/user/[id]/invoices.get'
import tokensGetH from '~/server/api/admin/api-tokens/index.get'
import tokenDeleteH from '~/server/api/admin/api-tokens/[id]/index.delete'
import { createItem, removeItem, updateItem } from '~/server/repos/itemRepo'
import { getById } from '~/server/repos/userRepo'
import { listForUserPage } from '~/server/repos/invoiceRepo'
import { deleteApiToken, listApiTokens } from '~/server/repos/apiTokenRepo'

vi.mock('~/server/repos/itemRepo', () => ({
  removeItem: vi.fn(),
  updateItem: vi.fn(),
  createItem: vi.fn(),
  getById: vi.fn(),
}))
vi.mock('~/server/repos/userRepo', () => ({ getById: vi.fn() }))
vi.mock('~/server/repos/invoiceRepo', () => ({ listForUserPage: vi.fn() }))
vi.mock('~/server/repos/apiTokenRepo', () => ({ listApiTokens: vi.fn(), deleteApiToken: vi.fn() }))
vi.mock('~/server/repos/auditRepo', () => ({ writeAudit: vi.fn() }))

const g = globalThis as unknown as {
  requireAdmin: ReturnType<typeof vi.fn>
  requireInteractiveAdmin: ReturnType<typeof vi.fn>
}

beforeEach(() => {
  vi.clearAllMocks()
  g.requireAdmin.mockResolvedValue({ id: 'a1' } as never)
  g.requireInteractiveAdmin.mockResolvedValue({ id: 'a1' } as never)
})

describe('admin item CRUD', () => {
  it('DELETE removes the item', async () => {
    expect(await deleteItemH(makeEvent({ params: { id: 'i1' } }) as never)).toEqual({ ok: true })
    expect(removeItem).toHaveBeenCalledWith('i1')
  })
  it('PUT updates the item, 404 when missing', async () => {
    vi.mocked(updateItem).mockResolvedValue({ id: 'i1' } as never)
    await putItemH(makeEvent({ params: { id: 'i1' }, body: { hidden: true } }) as never)
    expect(updateItem).toHaveBeenCalledWith('i1', { hidden: true })
    vi.mocked(updateItem).mockResolvedValue(undefined as never)
    await expect(putItemH(makeEvent({ params: { id: 'i1' }, body: {} }) as never)).rejects.toMatchObject({
      statusCode: 404,
    })
  })
  it('PUT falls back to empty patch when body is null', async () => {
    vi.mocked(updateItem).mockResolvedValue({ id: 'i1' } as never)
    await putItemH(makeEvent({ params: { id: 'i1' }, body: null }) as never)
    expect(updateItem).toHaveBeenCalledWith('i1', {})
  })
  // The antiFeature is a silently-failed save: a write that throws must NOT be swallowed into a fake
  // success — the curator has to learn the catalog still holds the old data. Falsifiable: wrap
  // updateItem in a try/catch that returns a value and this fails.
  it('PUT surfaces a write failure instead of silently succeeding', async () => {
    vi.mocked(updateItem).mockRejectedValue(new Error('db write failed'))
    await expect(putItemH(makeEvent({ params: { id: 'i1' }, body: { hidden: true } }) as never)).rejects.toThrow(
      'db write failed',
    )
  })
  it('POST creates the item owned by the admin', async () => {
    vi.mocked(createItem).mockResolvedValue({ id: 'new' } as never)
    await createItemH(makeEvent({ body: { title: 'X' } }) as never)
    expect(createItem).toHaveBeenCalledWith({ title: 'X' }, 'a1')
  })
  it('POST falls back to empty body when body is null', async () => {
    vi.mocked(createItem).mockResolvedValue({ id: 'new' } as never)
    await createItemH(makeEvent({ body: null }) as never)
    expect(createItem).toHaveBeenCalledWith({}, 'a1')
  })
})

describe('admin user reads', () => {
  it('GET user, 404 when missing', async () => {
    vi.mocked(getById).mockResolvedValue({ id: 'u1' } as never)
    await expect(userGetH(makeEvent({ params: { id: 'u1' } }) as never)).resolves.toMatchObject({ id: 'u1' })
    vi.mocked(getById).mockResolvedValue(undefined as never)
    await expect(userGetH(makeEvent({ params: { id: 'x' } }) as never)).rejects.toMatchObject({ statusCode: 404 })
  })
  it('GET user invoices', async () => {
    vi.mocked(listForUserPage).mockResolvedValue({ items: [] } as never)
    await userInvoicesH(makeEvent({ params: { id: 'u1' } }) as never)
    expect(listForUserPage).toHaveBeenCalledWith('u1', expect.objectContaining({ pageSize: 10 }))
  })
})

describe('admin api-tokens', () => {
  it('GET lists tokens', async () => {
    vi.mocked(listApiTokens).mockResolvedValue({ items: [] } as never)
    await tokensGetH(makeEvent() as never)
    expect(listApiTokens).toHaveBeenCalledWith(expect.objectContaining({ pageSize: 20 }))
  })
  it('DELETE 400 without id, 404 when not found, ok when deleted', async () => {
    await expect(tokenDeleteH(makeEvent({ params: {} }) as never)).rejects.toMatchObject({ statusCode: 400 })
    vi.mocked(deleteApiToken).mockResolvedValue(false as never)
    await expect(tokenDeleteH(makeEvent({ params: { id: 't1' } }) as never)).rejects.toMatchObject({ statusCode: 404 })
    vi.mocked(deleteApiToken).mockResolvedValue(true as never)
    expect(await tokenDeleteH(makeEvent({ params: { id: 't1' } }) as never)).toEqual({ ok: true })
  })
})
