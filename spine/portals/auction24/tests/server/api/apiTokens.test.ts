import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeEvent } from '../../setup/server'

import handler from '~/server/api/admin/api-tokens/index.post'
import { createApiToken } from '~/server/repos/apiTokenRepo'

vi.mock('~/server/repos/apiTokenRepo', () => ({ createApiToken: vi.fn() }))

const g = globalThis as unknown as { requireInteractiveAdmin: ReturnType<typeof vi.fn> }

beforeEach(() => {
  vi.clearAllMocks()
  g.requireInteractiveAdmin.mockResolvedValue({ id: 'a1', fullName: 'Admin' } as never)
  ;(globalThis as Record<string, unknown>).useRuntimeConfig = () => ({ internalApiSecret: 'pepper' })
})

describe('POST /api/admin/api-tokens', () => {
  it('creates a token for a valid name', async () => {
    vi.mocked(createApiToken).mockResolvedValue({ id: 't1', token: 'grg_x' } as never)
    const res = await handler(makeEvent({ body: { name: 'CI token' } }) as never)
    expect(createApiToken).toHaveBeenCalledWith({ name: 'CI token', createdBy: 'a1', createdByName: 'Admin' }, 'pepper')
    expect(res).toMatchObject({ token: 'grg_x' })
  })

  it.each([
    ['', 'empty'],
    [' '.repeat(3), 'whitespace'],
    ['x'.repeat(101), 'too long'],
  ])('400s on a %s name', async name => {
    await expect(handler(makeEvent({ body: { name } }) as never)).rejects.toMatchObject({ statusCode: 400 })
    expect(createApiToken).not.toHaveBeenCalled()
  })

  it('500s when the internal secret is missing', async () => {
    ;(globalThis as Record<string, unknown>).useRuntimeConfig = () => ({})
    await expect(handler(makeEvent({ body: { name: 'ok' } }) as never)).rejects.toMatchObject({ statusCode: 500 })
  })

  it('400s when name is not a string', async () => {
    await expect(handler(makeEvent({ body: { name: 123 } }) as never)).rejects.toMatchObject({ statusCode: 400 })
    expect(createApiToken).not.toHaveBeenCalled()
  })

  it('400s when the body has no name field', async () => {
    await expect(handler(makeEvent({ body: {} }) as never)).rejects.toMatchObject({ statusCode: 400 })
    expect(createApiToken).not.toHaveBeenCalled()
  })

  it('falls back to an empty body when readBody rejects', async () => {
    const original = (globalThis as Record<string, unknown>).readBody
    ;(globalThis as Record<string, unknown>).readBody = vi.fn().mockRejectedValue(new Error('bad json'))
    try {
      // Body resolves to {} → name becomes '' → 400, proving the .catch fallback ran.
      await expect(handler(makeEvent({ body: { name: 'ignored' } }) as never)).rejects.toMatchObject({
        statusCode: 400,
      })
      expect(createApiToken).not.toHaveBeenCalled()
    } finally {
      ;(globalThis as Record<string, unknown>).readBody = original
    }
  })

  it('trims the name and passes through an undefined admin fullName', async () => {
    g.requireInteractiveAdmin.mockResolvedValue({ id: 'a2', fullName: undefined } as never)
    vi.mocked(createApiToken).mockResolvedValue({ id: 't2', token: 'grg_y' } as never)
    const res = await handler(makeEvent({ body: { name: '  Padded  ' } }) as never)
    expect(createApiToken).toHaveBeenCalledWith({ name: 'Padded', createdBy: 'a2', createdByName: undefined }, 'pepper')
    expect(res).toMatchObject({ token: 'grg_y' })
  })
})
