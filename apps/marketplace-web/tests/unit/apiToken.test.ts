import { describe, it, expect } from 'vitest'
import { API_TOKEN_PREFIX, apiTokenDisplayPrefix, generateApiToken, hashApiToken } from '~/server/utils/apiToken'

describe('generateApiToken', () => {
  it('has the grg_ prefix and 64 hex chars of entropy', () => {
    const token = generateApiToken()
    expect(token.startsWith(API_TOKEN_PREFIX)).toBe(true)
    expect(token.slice(API_TOKEN_PREFIX.length)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('produces unique tokens', () => {
    const set = new Set(Array.from({ length: 200 }, () => generateApiToken()))
    expect(set.size).toBe(200)
  })
})

describe('hashApiToken', () => {
  it('is deterministic for the same token + secret', () => {
    expect(hashApiToken('grg_abc', 's')).toBe(hashApiToken('grg_abc', 's'))
  })

  it('depends on the secret', () => {
    expect(hashApiToken('grg_abc', 's1')).not.toBe(hashApiToken('grg_abc', 's2'))
  })

  it('depends on the token', () => {
    expect(hashApiToken('grg_abc', 's')).not.toBe(hashApiToken('grg_xyz', 's'))
  })

  it('returns 64 lowercase hex chars (sha256)', () => {
    expect(hashApiToken('grg_abc', 's')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('apiTokenDisplayPrefix', () => {
  it('returns the first 12 chars', () => {
    const token = generateApiToken()
    expect(apiTokenDisplayPrefix(token)).toBe(token.slice(0, 12))
    expect(apiTokenDisplayPrefix(token)).toHaveLength(12)
  })
})
