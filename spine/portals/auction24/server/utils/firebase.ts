import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { initializeApp, applicationDefault, cert, getApps, type ServiceAccount } from 'firebase-admin/app'
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'

const ensureApp = () => {
  if (getApps().length > 0) return

  const storageBucket = process.env.FIREBASE_STORAGE_BUCKET

  // Emulator host reroutes the Admin SDK to the local auth emulator with stub creds.
  if (process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || 'demo-garaaage-auction', storageBucket })
    return
  }

  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS

  // App Hosting provides ADC; locally fall back to a service account file.
  const credential = credentialsPath
    ? cert(JSON.parse(readFileSync(credentialsPath, 'utf-8')) as ServiceAccount)
    : applicationDefault()

  initializeApp({ credential, storageBucket })
}

export const getAuthAdmin = () => {
  ensureApp()
  return getAuth()
}

let cachedBucket: ReturnType<typeof getStorage> extends { bucket: () => infer R } ? R : never

export const getStorageBucket = () => {
  if (cachedBucket) return cachedBucket
  ensureApp()
  // Make a misconfigured bucket a clear log line: getStorage().bucket() otherwise
  // throws a generic Firebase error that the upload handler flattens into an opaque
  // 503. The bucket is <project>.firebasestorage.app, not <project>.appspot.com.
  if (!process.env.FIREBASE_STORAGE_BUCKET) {
    throw new Error('FIREBASE_STORAGE_BUCKET is not set — image uploads cannot work')
  }
  cachedBucket = getStorage().bucket()
  return cachedBucket
}

// Firestore reader for the migration script; reuses the single Admin app.
export const getFirestoreAdmin = (): Firestore => {
  ensureApp()
  return getFirestore()
}

// Local-only verification (sig + exp + iss/aud). Revocation is enforced
// downstream via users.tokens_valid_after; checkRevoked adds a 300–500ms round-trip.
const TOKEN_CACHE_MAX = 2000
const TOKEN_CACHE_MAX_TTL_MS = 60_000
const tokenCache = new Map<string, { decoded: DecodedIdToken; expiresAt: number }>()

const tokenCacheKey = (idToken: string): string => createHash('sha256').update(idToken).digest('hex').slice(0, 32)

export const verifyIdToken = async (idToken: string): Promise<DecodedIdToken> => {
  const key = tokenCacheKey(idToken)
  const now = Date.now()
  const hit = tokenCache.get(key)
  if (hit && hit.expiresAt > now) {
    tokenCache.delete(key)
    tokenCache.set(key, hit)
    return hit.decoded
  }
  const decoded = await getAuthAdmin().verifyIdToken(idToken)
  const expiresAt = Math.min(decoded.exp * 1000, now + TOKEN_CACHE_MAX_TTL_MS)
  if (expiresAt > now) {
    if (tokenCache.size >= TOKEN_CACHE_MAX) {
      const oldest = tokenCache.keys().next().value
      if (oldest !== undefined) tokenCache.delete(oldest)
    }
    tokenCache.set(key, { decoded, expiresAt })
  }
  return decoded
}
