import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserRow } from '~/server/db/schema'
import { makeEvent } from '../setup/server'

import { getSessionUser, requireAdmin, requireInteractiveAdmin, requireSession } from '~/server/utils/session'
import { findApiTokenWithOwner } from '~/server/repos/apiTokenRepo'

// The API-token path of getSessionUser resolves against the token table (no Firebase/DB user read),
// so it exercises getSessionUser + requireSession/requireAdmin/requireInteractiveAdmin without pg.
vi.mock('~/server/repos/apiTokenRepo', () => ({ findApiTokenWithOwner: vi.fn(), touchApiTokenLastUsed: vi.fn() }))
vi.mock('~/server/utils/firebase', () => ({ verifyIdToken: vi.fn() }))

const row = (over: Partial<UserRow> = {}): UserRow =>
  ({
    id: 'u1',
    authType: 'email',
    fullName: 'Jan',
    email: 'j@x.cz',
    companyName: null,
    companyVatNumber: null,
    companyIdNumber: null,
    bankAccount: null,
    phone: null,
    address: null,
    vat: null,
    roles: ['user'],
    depositBalanceAmount: null,
    depositBalanceCurrency: null,
    depositVs: '1234567890',
    invoiceDueDays: 14,
    favoriteIds: [],
    languageCode: 'cz',
    newsletter: false,
    emailVerified: false,
    depositRequired: true,
    fakturoidId: null,
    banned: false,
    tokensValidAfter: new Date(0),
    created: new Date('2024-01-01'),
    deletedAt: null,
    ...over,
  }) as UserRow

const tokenEvent = () => makeEvent({ headers: { authorization: 'Bearer grg_tok' } })

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as Record<string, unknown>).useRuntimeConfig = () => ({ internalApiSecret: 'pepper' })
  vi.mocked(findApiTokenWithOwner).mockResolvedValue({ tokenId: 't1', owner: row() })
})

describe('getSessionUser (API-token path)', () => {
  it('resolves the owner and caches per request', async () => {
    const event = tokenEvent()
    const user = await getSessionUser(event)
    expect(user?.id).toBe('u1')
    await getSessionUser(event) // cached — no second lookup
    expect(findApiTokenWithOwner).toHaveBeenCalledTimes(1)
  })

  it('returns null for anonymous, missing secret, unknown token, or banned owner', async () => {
    expect(await getSessionUser(makeEvent())).toBeNull() // no Authorization
    ;(globalThis as Record<string, unknown>).useRuntimeConfig = () => ({})
    expect(await getSessionUser(tokenEvent())).toBeNull() // no internalApiSecret
    ;(globalThis as Record<string, unknown>).useRuntimeConfig = () => ({ internalApiSecret: 'pepper' })

    vi.mocked(findApiTokenWithOwner).mockResolvedValue(undefined)
    expect(await getSessionUser(tokenEvent())).toBeNull() // unknown token

    vi.mocked(findApiTokenWithOwner).mockResolvedValue({ tokenId: 't1', owner: row({ banned: true }) })
    expect(await getSessionUser(tokenEvent())).toBeNull() // banned owner
  })
})

describe('requireSession / requireAdmin / requireInteractiveAdmin', () => {
  it('requireSession returns the user, 401 when anonymous', async () => {
    expect((await requireSession(tokenEvent())).id).toBe('u1')
    await expect(requireSession(makeEvent())).rejects.toMatchObject({ statusCode: 401 })
  })

  it('requireAdmin gates on the admin role', async () => {
    await expect(requireAdmin(tokenEvent())).rejects.toMatchObject({ statusCode: 403 })
    vi.mocked(findApiTokenWithOwner).mockResolvedValue({ tokenId: 't1', owner: row({ roles: ['user', 'admin'] }) })
    expect((await requireAdmin(tokenEvent())).id).toBe('u1')
  })

  it('requireInteractiveAdmin blocks API-token sessions from managing tokens', async () => {
    vi.mocked(findApiTokenWithOwner).mockResolvedValue({ tokenId: 't1', owner: row({ roles: ['user', 'admin'] }) })
    await expect(requireInteractiveAdmin(tokenEvent())).rejects.toMatchObject({ statusCode: 403 })
  })
})
