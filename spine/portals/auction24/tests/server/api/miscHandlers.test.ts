import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeEvent } from '../../setup/server'

import catchAll from '~/server/api/[...]'
import contactMessages from '~/server/api/admin/contact-messages.get'
import { listContactMessagesPage } from '~/server/repos/contactRepo'

vi.mock('~/server/repos/contactRepo', () => ({ listContactMessagesPage: vi.fn() }))

beforeEach(() => vi.clearAllMocks())

describe('catch-all /api/** handler', () => {
  it('returns a JSON 404 for unmatched routes', () => {
    expect(() => catchAll(makeEvent() as never)).toThrowError(expect.objectContaining({ statusCode: 404 }))
  })
})

describe('GET /api/admin/contact-messages', () => {
  it('lists messages for an admin with pageSize 20', async () => {
    vi.mocked(listContactMessagesPage).mockResolvedValue({ items: [] } as never)
    await contactMessages(makeEvent() as never)
    expect(listContactMessagesPage).toHaveBeenCalledWith(expect.objectContaining({ pageSize: 20 }))
  })
})
