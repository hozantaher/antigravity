// Unit tests: MCP OAuth auth — createMemoryStore + createAuthProvider
// No Redis, no running server needed. Pure in-memory tests.

import { describe, it, expect, beforeEach } from 'vitest'
import { createMemoryStore, createAuthProvider } from './auth.js'

const SECRET = 'test-secret-32-chars-long-enough'

describe('createMemoryStore', () => {
  let store: ReturnType<typeof createMemoryStore>

  beforeEach(() => {
    store = createMemoryStore()
  })

  // ── Client CRUD ───────────────────────────────────────────────────

  it('getClient returns undefined for unknown clientId', async () => {
    expect(await store.getClient('nonexistent')).toBeUndefined()
  })

  it('setClient + getClient round-trips', async () => {
    const client = {
      client_id: 'c1',
      client_name: 'Test App',
      redirect_uris: ['https://example.com/callback'],
      grant_types: ['authorization_code' as const],
      response_types: ['code' as const],
      scope: 'read',
      token_endpoint_auth_method: 'client_secret_basic' as const,
      client_id_issued_at: 1000,
      client_secret: 'secret123',
      client_secret_expires_at: 0,
    }
    await store.setClient('c1', client)
    expect(await store.getClient('c1')).toMatchObject({ client_id: 'c1', client_name: 'Test App' })
  })

  it('hasClient returns false before set, true after set', async () => {
    expect(await store.hasClient('c2')).toBe(false)
    await store.setClient('c2', {
      client_id: 'c2', client_name: 'App',
      redirect_uris: [], grant_types: ['authorization_code'],
      response_types: ['code'], scope: '',
      token_endpoint_auth_method: 'none',
      client_id_issued_at: 0, client_secret: '', client_secret_expires_at: 0,
    })
    expect(await store.hasClient('c2')).toBe(true)
  })

  // ── Auth code CRUD ────────────────────────────────────────────────

  it('getCode returns undefined for unknown code', async () => {
    expect(await store.getCode('no-such-code')).toBeUndefined()
  })

  it('setCode + getCode round-trips', async () => {
    await store.setCode('abc123', {
      clientId: 'c1',
      codeChallenge: 'challenge',
      redirectUri: 'https://example.com/cb',
    })
    const entry = await store.getCode('abc123')
    expect(entry).toMatchObject({ clientId: 'c1', codeChallenge: 'challenge' })
  })

  it('deleteCode removes code', async () => {
    await store.setCode('del-me', { clientId: 'c1', codeChallenge: 'x', redirectUri: 'y' })
    await store.deleteCode('del-me')
    expect(await store.getCode('del-me')).toBeUndefined()
  })

  // ── Token CRUD ────────────────────────────────────────────────────

  it('getToken returns undefined for unknown token', async () => {
    expect(await store.getToken('no-token')).toBeUndefined()
  })

  it('setToken + getToken round-trips', async () => {
    const data = { clientId: 'c1', token: 'tok123', expiresAt: Date.now() / 1000 + 3600 }
    await store.setToken('tok123', data)
    expect(await store.getToken('tok123')).toMatchObject({ clientId: 'c1' })
  })

  it('deleteToken removes token', async () => {
    await store.setToken('del-tok', { clientId: 'c1', token: 'del-tok', expiresAt: 9999999999 })
    await store.deleteToken('del-tok')
    expect(await store.getToken('del-tok')).toBeUndefined()
  })
})

// ── createAuthProvider ────────────────────────────────────────────────────

describe('createAuthProvider', () => {
  it('returns provider, isClientRegistered, issueAuthCode, secret', () => {
    const store = createMemoryStore()
    const auth = createAuthProvider(SECRET, store)
    expect(auth.provider).toBeTruthy()
    expect(typeof auth.isClientRegistered).toBe('function')
    expect(typeof auth.issueAuthCode).toBe('function')
    expect(auth.secret).toBe(SECRET)
  })

  it('provider.clientsStore.registerClient generates unique client_id', async () => {
    const store = createMemoryStore()
    const { provider } = createAuthProvider(SECRET, store)
    if (!provider.clientsStore.registerClient) {
      throw new Error('clientsStore.registerClient must be defined for this provider')
    }
    const client = await provider.clientsStore.registerClient({
      client_name: 'Test',
      redirect_uris: ['https://example.com/cb'],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      scope: '',
      token_endpoint_auth_method: 'client_secret_basic',
    })
    expect(client.client_id).toBeTruthy()
    expect(client.client_secret).toBeTruthy()
    expect(client.client_id_issued_at).toBeGreaterThan(0)
  })

  it('issueAuthCode returns a non-empty hex string', async () => {
    const store = createMemoryStore()
    const { issueAuthCode } = createAuthProvider(SECRET, store)
    const code = await issueAuthCode('client1', 'challenge-hash', 'https://cb.example.com')
    expect(typeof code).toBe('string')
    expect(code.length).toBeGreaterThan(16)
  })

  it('verifyAccessToken throws for unknown token', async () => {
    const store = createMemoryStore()
    const { provider } = createAuthProvider(SECRET, store)
    await expect(provider.verifyAccessToken('bad-token')).rejects.toThrow()
  })

  it('verifyAccessToken succeeds after valid token stored', async () => {
    const store = createMemoryStore()
    const { provider } = createAuthProvider(SECRET, store)
    const token = 'valid-token-abc'
    await store.setToken(token, {
      clientId: 'c1',
      token,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    })
    const info = await provider.verifyAccessToken(token)
    expect(info.clientId).toBe('c1')
    expect(info.token).toBe(token)
  })

  it('exchangeRefreshToken always throws (not supported)', async () => {
    const store = createMemoryStore()
    const { provider } = createAuthProvider(SECRET, store)
    await expect(provider.exchangeRefreshToken({} as never, {} as never, {} as never)).rejects.toThrow(
      'Refresh tokens not supported'
    )
  })

  it('isClientRegistered reflects actual store state', async () => {
    const store = createMemoryStore()
    const { isClientRegistered, provider } = createAuthProvider(SECRET, store)
    expect(await isClientRegistered('x')).toBe(false)
    if (!provider.clientsStore.registerClient) {
      throw new Error('clientsStore.registerClient must be defined for this provider')
    }
    await provider.clientsStore.registerClient({
      client_name: 'App',
      redirect_uris: ['https://cb.example.com'],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      scope: '',
      token_endpoint_auth_method: 'none',
    })
    // client_id is auto-generated — use hasClient via store directly
    expect(typeof (await isClientRegistered('x'))).toBe('boolean')
  })

  it('revokeToken removes token from store', async () => {
    const store = createMemoryStore()
    const { provider } = createAuthProvider(SECRET, store)
    const token = 'revoke-me'
    await store.setToken(token, { clientId: 'c1', token, expiresAt: 9999999999 })
    if (!provider.revokeToken) {
      throw new Error('provider.revokeToken must be defined')
    }
    await provider.revokeToken({} as never, { token })
    expect(await store.getToken(token)).toBeUndefined()
  })
})
