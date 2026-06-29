import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getAuthAdmin, getStorageBucket, verifyIdToken } from '~/server/utils/firebase'

const verifyIdTokenMock = vi.fn()
const bucketObj = { name: 'bucket' }

vi.mock('firebase-admin/app', () => ({
  getApps: () => [{}], // pretend an app exists so ensureApp() skips real init
  initializeApp: vi.fn(),
  cert: vi.fn(),
  applicationDefault: vi.fn(),
}))
vi.mock('firebase-admin/auth', () => ({ getAuth: () => ({ verifyIdToken: verifyIdTokenMock }) }))
vi.mock('firebase-admin/firestore', () => ({ getFirestore: () => ({}) }))
vi.mock('firebase-admin/storage', () => ({ getStorage: () => ({ bucket: () => bucketObj }) }))

const origBucketEnv = process.env.FIREBASE_STORAGE_BUCKET

beforeEach(() => {
  vi.clearAllMocks()
  verifyIdTokenMock.mockResolvedValue({ uid: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 })
})
afterEach(() => {
  if (origBucketEnv === undefined) delete process.env.FIREBASE_STORAGE_BUCKET
  else process.env.FIREBASE_STORAGE_BUCKET = origBucketEnv
})

describe('verifyIdToken', () => {
  it('verifies and caches per token (second hit skips the round-trip)', async () => {
    const a = await verifyIdToken('cache-token-A')
    const b = await verifyIdToken('cache-token-A')
    expect(a.uid).toBe('u1')
    expect(b).toBe(a)
    expect(verifyIdTokenMock).toHaveBeenCalledTimes(1)
  })

  it('verifies distinct tokens independently', async () => {
    await verifyIdToken('distinct-1')
    await verifyIdToken('distinct-2')
    expect(verifyIdTokenMock).toHaveBeenCalledTimes(2)
  })
})

describe('getStorageBucket', () => {
  it('throws a clear error without FIREBASE_STORAGE_BUCKET', () => {
    delete process.env.FIREBASE_STORAGE_BUCKET
    expect(() => getStorageBucket()).toThrow(/FIREBASE_STORAGE_BUCKET/)
  })

  it('returns the bucket when configured', () => {
    process.env.FIREBASE_STORAGE_BUCKET = 'garaaage.firebasestorage.app'
    expect(getStorageBucket()).toBe(bucketObj)
  })
})

describe('getAuthAdmin', () => {
  it('exposes the admin auth instance', () => {
    expect(getAuthAdmin().verifyIdToken).toBe(verifyIdTokenMock)
  })
})
