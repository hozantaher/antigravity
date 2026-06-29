import { describe, it, expect } from 'vitest'
import { AuthType } from '~/models'
import type { UserRow } from '~/server/db/schema'
import { extractBearerToken, checkUserRow, isUserActive } from '~/server/utils/session'

const row = (over: Partial<UserRow> = {}): UserRow => ({
  id: 'u1',
  authType: 'email',
  fullName: 'Jan',
  email: 'jan@x.cz',
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
  newsletterLastSentAt: null,
  emailVerified: false,
  depositRequired: true,
  fakturoidId: null,
  banned: false,
  tokensValidAfter: new Date('1970-01-01T00:00:00Z'),
  created: new Date('2024-01-01T00:00:00Z'),
  deletedAt: null,
  ...over,
})

describe('extractBearerToken', () => {
  it('parses a Bearer header case-insensitively', () => {
    expect(extractBearerToken('Bearer abc.def')).toBe('abc.def')
    expect(extractBearerToken('bearer xyz')).toBe('xyz')
  })
  it('returns null for missing or non-Bearer headers', () => {
    expect(extractBearerToken(undefined)).toBeNull()
    expect(extractBearerToken('Token abc')).toBeNull()
    expect(extractBearerToken('')).toBeNull()
  })
})

describe('isUserActive', () => {
  it('is false for a missing row', () => {
    expect(isUserActive(undefined)).toBe(false)
    expect(isUserActive(null)).toBe(false)
  })
  it('is false for a banned or soft-deleted user', () => {
    expect(isUserActive(row({ banned: true }))).toBe(false)
    expect(isUserActive(row({ deletedAt: new Date() }))).toBe(false)
  })
  it('is true for an active user', () => {
    expect(isUserActive(row())).toBe(true)
  })
})

describe('checkUserRow (ban + revocation gate)', () => {
  const tva = new Date('2025-01-01T00:00:00Z')

  it('returns the mapped user when the token is newer than tokensValidAfter', () => {
    const user = checkUserRow(tva.getTime() + 1000, row({ tokensValidAfter: tva }))
    expect(user?.id).toBe('u1')
    expect(user?.authType).toBe(AuthType.email)
  })

  it('rejects a banned user', () => {
    expect(checkUserRow(Date.now(), row({ banned: true }))).toBeNull()
  })

  it('rejects a token issued in a second before tokensValidAfter (logout revocation)', () => {
    expect(checkUserRow(tva.getTime() - 1000, row({ tokensValidAfter: tva }))).toBeNull()
    expect(checkUserRow(tva.getTime() - 1, row({ tokensValidAfter: tva }))).toBeNull()
  })

  it('accepts a fresh re-login token minted in the same second as the cutoff', () => {
    // iat is second-granular: a logout mid-second must not falsely revoke a token
    // re-issued in that same second.
    const midSecond = new Date(tva.getTime() + 500)
    expect(checkUserRow(tva.getTime(), row({ tokensValidAfter: midSecond }))?.id).toBe('u1')
  })

  it('returns null for a missing row', () => {
    expect(checkUserRow(Date.now(), undefined)).toBeNull()
    expect(checkUserRow(Date.now(), null)).toBeNull()
  })
})
