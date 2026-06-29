import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeEvent } from '../../setup/server'

import handler from '~/server/api/me.delete'
import { requireSession } from '~/server/utils/session'
import { getAuthAdmin } from '~/server/utils/firebase'
import { softDeleteUser } from '~/server/repos/userRepo'

vi.mock('~/server/utils/session', () => ({ requireSession: vi.fn() }))
vi.mock('~/server/utils/firebase', () => ({ getAuthAdmin: vi.fn(), verifyIdToken: vi.fn() }))
vi.mock('~/server/repos/userRepo', () => ({ softDeleteUser: vi.fn() }))

const deleteUser = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireSession).mockResolvedValue({ id: 'u1' } as never)
  vi.mocked(getAuthAdmin).mockReturnValue({ deleteUser } as never)
})

describe('DELETE /api/me', () => {
  it('removes the Firebase identity and soft-deletes the row', async () => {
    deleteUser.mockResolvedValue(undefined)
    const res = await handler(makeEvent({ method: 'DELETE' }) as never)
    expect(deleteUser).toHaveBeenCalledWith('u1')
    expect(softDeleteUser).toHaveBeenCalledWith('u1')
    expect(res).toEqual({ ok: true })
  })

  it('still soft-deletes when the Firebase delete fails (DB is the gate)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    deleteUser.mockRejectedValue(new Error('already gone'))
    const res = await handler(makeEvent({ method: 'DELETE' }) as never)
    expect(softDeleteUser).toHaveBeenCalledWith('u1')
    expect(res).toEqual({ ok: true })
    spy.mockRestore()
  })
})

afterEach(() => vi.restoreAllMocks())

// ---------------------------------------------------------------------------
// Real session.ts coverage. The top of this file vi.mock's '~/server/utils/session'
// and '~/server/utils/firebase' for the DELETE handler tests, so we pull the REAL
// modules via importActual and mock only their leaf dependencies (db / repos /
// firebase verifyIdToken) — never the network or pg.
// ---------------------------------------------------------------------------

vi.mock('~/server/repos/apiTokenRepo', () => ({
  findApiTokenWithOwner: vi.fn(),
  touchApiTokenLastUsed: vi.fn(),
}))

const dbExecuteTakeFirst = vi.fn()
vi.mock('~/server/utils/db', () => ({
  db: {
    selectFrom: () => ({
      selectAll: () => ({
        where: () => ({ executeTakeFirst: dbExecuteTakeFirst }),
      }),
    }),
  },
}))

type SessionModule = typeof import('~/server/utils/session')
type FirebaseModule = typeof import('~/server/utils/firebase')

const userRow = (over: Record<string, unknown> = {}) =>
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
    newsletterLastSentAt: null,
    emailVerified: false,
    depositRequired: true,
    fakturoidId: null,
    banned: false,
    tokensValidAfter: new Date(0),
    created: new Date('2024-01-01'),
    deletedAt: null,
    ...over,
  }) as never

describe('session.ts (real implementation)', () => {
  let session: SessionModule
  let apiTokenRepo: typeof import('~/server/repos/apiTokenRepo')
  let firebaseMock: FirebaseModule
  const g = globalThis as Record<string, unknown>
  const origRuntimeConfig = g.useRuntimeConfig

  const fbEvent = () => makeEvent({ headers: { authorization: 'Bearer fb.token' } })
  const tokenEvent = () => makeEvent({ headers: { authorization: 'Bearer grg_secret' } })

  beforeEach(async () => {
    vi.clearAllMocks()
    session = await vi.importActual<SessionModule>('~/server/utils/session')
    apiTokenRepo = await import('~/server/repos/apiTokenRepo')
    firebaseMock = await import('~/server/utils/firebase')
    g.useRuntimeConfig = () => ({ internalApiSecret: 'pepper', cronSecret: 'cron-secret' })
    vi.mocked(apiTokenRepo.findApiTokenWithOwner).mockResolvedValue({ tokenId: 't1', owner: userRow() })
    vi.mocked(firebaseMock.verifyIdToken).mockResolvedValue({
      uid: 'u1',
      iat: Math.floor(Date.now() / 1000),
    } as never)
    dbExecuteTakeFirst.mockResolvedValue(userRow())
  })

  afterEach(() => {
    g.useRuntimeConfig = origRuntimeConfig
  })

  describe('extractBearerToken', () => {
    it('parses, and returns null for missing/non-Bearer headers', () => {
      expect(session.extractBearerToken('Bearer abc.def')).toBe('abc.def')
      expect(session.extractBearerToken('bearer xyz')).toBe('xyz')
      expect(session.extractBearerToken(undefined)).toBeNull()
      expect(session.extractBearerToken('Token abc')).toBeNull()
    })
  })

  describe('isUserActive', () => {
    it('covers nullish, banned, soft-deleted and active', () => {
      expect(session.isUserActive(undefined)).toBe(false)
      expect(session.isUserActive(null)).toBe(false)
      expect(session.isUserActive(userRow({ banned: true }))).toBe(false)
      expect(session.isUserActive(userRow({ deletedAt: new Date() }))).toBe(false)
      expect(session.isUserActive(userRow())).toBe(true)
    })
  })

  describe('checkUserRow', () => {
    it('rejects inactive rows', () => {
      expect(session.checkUserRow(Date.now(), null)).toBeNull()
      expect(session.checkUserRow(Date.now(), userRow({ banned: true }))).toBeNull()
    })
    it('rejects tokens issued before tokensValidAfter', () => {
      const tva = new Date('2025-01-01T00:00:00Z')
      expect(session.checkUserRow(tva.getTime() - 2000, userRow({ tokensValidAfter: tva }))).toBeNull()
    })
    it('returns the mapped user for a valid token', () => {
      const tva = new Date('2025-01-01T00:00:00Z')
      expect(session.checkUserRow(tva.getTime() + 2000, userRow({ tokensValidAfter: tva }))?.id).toBe('u1')
    })
  })

  describe('getSessionUser', () => {
    it('returns null and caches when there is no Authorization header', async () => {
      const event = makeEvent()
      expect(await session.getSessionUser(event)).toBeNull()
      // second call hits the cached NO_SESSION branch
      expect(await session.getSessionUser(event)).toBeNull()
    })

    it('resolves and caches a Firebase session', async () => {
      const event = fbEvent()
      const user = await session.getSessionUser(event)
      expect(user?.id).toBe('u1')
      // cached user branch
      expect((await session.getSessionUser(event))?.id).toBe('u1')
      expect(firebaseMock.verifyIdToken).toHaveBeenCalledTimes(1)
    })

    it('rejects when verifyIdToken throws', async () => {
      vi.mocked(firebaseMock.verifyIdToken).mockRejectedValue(new Error('bad token'))
      expect(await session.getSessionUser(fbEvent())).toBeNull()
    })

    it('rejects when the DB row fails the active/revocation gate', async () => {
      dbExecuteTakeFirst.mockResolvedValue(userRow({ banned: true }))
      expect(await session.getSessionUser(fbEvent())).toBeNull()
    })

    it('rejects when the DB row is missing', async () => {
      dbExecuteTakeFirst.mockResolvedValue(undefined)
      expect(await session.getSessionUser(fbEvent())).toBeNull()
    })

    it('resolves an API-token session and touches last-used', async () => {
      const event = tokenEvent()
      const user = await session.getSessionUser(event)
      expect(user?.id).toBe('u1')
      expect(apiTokenRepo.touchApiTokenLastUsed).toHaveBeenCalledWith('t1')
    })

    it('rejects an API-token session without internalApiSecret', async () => {
      g.useRuntimeConfig = () => ({})
      expect(await session.getSessionUser(tokenEvent())).toBeNull()
    })

    it('rejects an unknown API token', async () => {
      vi.mocked(apiTokenRepo.findApiTokenWithOwner).mockResolvedValue(undefined)
      expect(await session.getSessionUser(tokenEvent())).toBeNull()
    })

    it('rejects an API token whose owner is inactive', async () => {
      vi.mocked(apiTokenRepo.findApiTokenWithOwner).mockResolvedValue({
        tokenId: 't1',
        owner: userRow({ deletedAt: new Date() }),
      })
      expect(await session.getSessionUser(tokenEvent())).toBeNull()
    })
  })

  describe('requireSession / requireAdmin / requireInteractiveAdmin', () => {
    it('requireSession returns the user, 401 when anonymous', async () => {
      expect((await session.requireSession(fbEvent())).id).toBe('u1')
      await expect(session.requireSession(makeEvent())).rejects.toMatchObject({ statusCode: 401 })
    })

    it('requireAdmin gates on the admin role', async () => {
      await expect(session.requireAdmin(fbEvent())).rejects.toMatchObject({ statusCode: 403 })
      dbExecuteTakeFirst.mockResolvedValue(userRow({ roles: ['user', 'admin'] }))
      expect((await session.requireAdmin(fbEvent())).id).toBe('u1')
    })

    it('requireInteractiveAdmin allows a Firebase admin but blocks an API-token admin', async () => {
      dbExecuteTakeFirst.mockResolvedValue(userRow({ roles: ['user', 'admin'] }))
      expect((await session.requireInteractiveAdmin(fbEvent())).id).toBe('u1')

      vi.mocked(apiTokenRepo.findApiTokenWithOwner).mockResolvedValue({
        tokenId: 't1',
        owner: userRow({ roles: ['user', 'admin'] }),
      })
      await expect(session.requireInteractiveAdmin(tokenEvent())).rejects.toMatchObject({ statusCode: 403 })
    })
  })

  describe('requireCronSecret', () => {
    it('503s when the cron secret is unconfigured', () => {
      g.useRuntimeConfig = () => ({})
      expect(() => session.requireCronSecret(makeEvent({ headers: { authorization: 'Bearer x' } }))).toThrow(
        expect.objectContaining({ statusCode: 503 }),
      )
    })

    it('401s when no token is present', () => {
      expect(() => session.requireCronSecret(makeEvent())).toThrow(expect.objectContaining({ statusCode: 401 }))
    })

    it('401s on a mismatched secret', () => {
      expect(() => session.requireCronSecret(makeEvent({ headers: { authorization: 'Bearer wrong' } }))).toThrow(
        expect.objectContaining({ statusCode: 401 }),
      )
    })

    it('passes for the correct secret', () => {
      expect(() =>
        session.requireCronSecret(makeEvent({ headers: { authorization: 'Bearer cron-secret' } })),
      ).not.toThrow()
    })
  })
})

// ---------------------------------------------------------------------------
// Real firebase.ts coverage. firebase-admin packages are mocked at module level
// so ensureApp() never touches Google. We toggle getApps()/env per test to walk
// every initialization branch.
// ---------------------------------------------------------------------------

const fbApps: unknown[] = []
const initializeAppMock = vi.fn()
const certMock = vi.fn((v: unknown) => ({ kind: 'cert', v }))
const applicationDefaultMock = vi.fn(() => ({ kind: 'adc' }))
const verifyIdTokenAdminMock = vi.fn()
const bucketMock = { name: 'the-bucket' }
const firestoreMock = { kind: 'firestore' }

vi.mock('firebase-admin/app', () => ({
  getApps: () => fbApps,
  initializeApp: (...args: unknown[]) => {
    initializeAppMock(...args)
    fbApps.push({})
  },
  cert: (v: unknown) => certMock(v),
  applicationDefault: () => applicationDefaultMock(),
}))
vi.mock('firebase-admin/auth', () => ({ getAuth: () => ({ verifyIdToken: verifyIdTokenAdminMock }) }))
vi.mock('firebase-admin/firestore', () => ({ getFirestore: () => firestoreMock }))
vi.mock('firebase-admin/storage', () => ({ getStorage: () => ({ bucket: () => bucketMock }) }))
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(() => '{"project_id":"p"}') }
})

describe('firebase.ts (real implementation)', () => {
  type FbModule = typeof import('~/server/utils/firebase')
  let fb: FbModule
  const env = process.env
  const saved = {
    bucket: env.FIREBASE_STORAGE_BUCKET,
    emulator: env.FIREBASE_AUTH_EMULATOR_HOST,
    creds: env.GOOGLE_APPLICATION_CREDENTIALS,
    project: env.FIREBASE_PROJECT_ID,
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    fbApps.length = 0
    fb = await vi.importActual<FbModule>('~/server/utils/firebase')
    delete env.FIREBASE_AUTH_EMULATOR_HOST
    delete env.GOOGLE_APPLICATION_CREDENTIALS
    delete env.FIREBASE_PROJECT_ID
    env.FIREBASE_STORAGE_BUCKET = 'demo.firebasestorage.app'
    verifyIdTokenAdminMock.mockResolvedValue({ uid: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 })
  })

  afterEach(() => {
    if (saved.bucket === undefined) delete env.FIREBASE_STORAGE_BUCKET
    else env.FIREBASE_STORAGE_BUCKET = saved.bucket
    if (saved.emulator === undefined) delete env.FIREBASE_AUTH_EMULATOR_HOST
    else env.FIREBASE_AUTH_EMULATOR_HOST = saved.emulator
    if (saved.creds === undefined) delete env.GOOGLE_APPLICATION_CREDENTIALS
    else env.GOOGLE_APPLICATION_CREDENTIALS = saved.creds
    if (saved.project === undefined) delete env.FIREBASE_PROJECT_ID
    else env.FIREBASE_PROJECT_ID = saved.project
  })

  describe('ensureApp via getAuthAdmin', () => {
    it('inits with applicationDefault (ADC) when no creds path is set', () => {
      fb.getAuthAdmin()
      expect(applicationDefaultMock).toHaveBeenCalled()
      expect(initializeAppMock).toHaveBeenCalledWith(
        expect.objectContaining({ credential: { kind: 'adc' }, storageBucket: 'demo.firebasestorage.app' }),
      )
    })

    it('skips init when an app already exists', () => {
      fbApps.push({})
      fb.getAuthAdmin()
      expect(initializeAppMock).not.toHaveBeenCalled()
    })

    it('inits with a service-account cert when GOOGLE_APPLICATION_CREDENTIALS is set', () => {
      env.GOOGLE_APPLICATION_CREDENTIALS = '/tmp/sa.json'
      fb.getAuthAdmin()
      expect(certMock).toHaveBeenCalled()
      expect(applicationDefaultMock).not.toHaveBeenCalled()
    })

    it('inits with the emulator branch and a default project id', () => {
      env.FIREBASE_AUTH_EMULATOR_HOST = 'localhost:9099'
      fb.getAuthAdmin()
      expect(initializeAppMock).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'demo-garaaage-auction' }))
    })

    it('uses FIREBASE_PROJECT_ID in the emulator branch when present', () => {
      env.FIREBASE_AUTH_EMULATOR_HOST = 'localhost:9099'
      env.FIREBASE_PROJECT_ID = 'my-project'
      fb.getAuthAdmin()
      expect(initializeAppMock).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'my-project' }))
    })
  })

  describe('getStorageBucket', () => {
    it('throws a clear error without FIREBASE_STORAGE_BUCKET', () => {
      delete env.FIREBASE_STORAGE_BUCKET
      expect(() => fb.getStorageBucket()).toThrow(/FIREBASE_STORAGE_BUCKET/)
    })
    it('returns and memoizes the bucket', () => {
      const first = fb.getStorageBucket()
      expect(first).toBe(bucketMock)
      // cached branch: second call returns the same object without re-resolving env
      delete env.FIREBASE_STORAGE_BUCKET
      expect(fb.getStorageBucket()).toBe(bucketMock)
    })
  })

  describe('getFirestoreAdmin', () => {
    it('returns the firestore instance', () => {
      expect(fb.getFirestoreAdmin()).toBe(firestoreMock)
    })
  })

  describe('verifyIdToken', () => {
    it('verifies and caches per token (second hit reuses, then expires)', async () => {
      const a = await fb.verifyIdToken('tok-A')
      const b = await fb.verifyIdToken('tok-A')
      expect(b).toBe(a)
      expect(verifyIdTokenAdminMock).toHaveBeenCalledTimes(1)
    })

    it('does not cache an already-expired token', async () => {
      verifyIdTokenAdminMock.mockResolvedValue({ uid: 'u1', exp: Math.floor(Date.now() / 1000) - 10 })
      await fb.verifyIdToken('expired-tok')
      await fb.verifyIdToken('expired-tok')
      expect(verifyIdTokenAdminMock).toHaveBeenCalledTimes(2)
    })

    it('evicts the oldest entry once the cache is full', async () => {
      // fill beyond the 2000 cap so the size>=MAX eviction branch runs
      for (let i = 0; i < 2001; i += 1) {
        verifyIdTokenAdminMock.mockResolvedValueOnce({ uid: `u${i}`, exp: Math.floor(Date.now() / 1000) + 3600 })
        await fb.verifyIdToken(`bulk-${i}`)
      }
      expect(verifyIdTokenAdminMock.mock.calls.length).toBeGreaterThanOrEqual(2001)
    })
  })
})
