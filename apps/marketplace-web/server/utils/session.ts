import { createHash, timingSafeEqual } from 'node:crypto'
import type { H3Event } from 'h3'
import type { User } from '~/models'
import { UserRole } from '~/models'
import { db } from './db'
import type { UserRow } from '../db/schema'
import { verifyIdToken } from './firebase'
import { rowToUser } from '../repos/mappers'
import { API_TOKEN_PREFIX, hashApiToken } from './apiToken'
import { findApiTokenWithOwner, touchApiTokenLastUsed } from '../repos/apiTokenRepo'

export const extractBearerToken = (header: string | undefined): string | null => {
  if (!header) return null
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match?.[1] ?? null
}

// Account-level gate shared by both auth schemes: a banned or soft-deleted user has no session.
// Add new account-wide lockouts here so the Firebase and API-token paths can't drift apart.
export const isUserActive = (row: UserRow | undefined | null): row is UserRow => !!row && !row.banned && !row.deletedAt

// Pure DB-side gate: reject banned users and tokens revoked by logout.
// Firebase `iat` is second-granular, so we compare at second resolution (like
// the Admin SDK's checkRevoked): a token is revoked only if it was issued in a
// second strictly before the logout. Comparing ms here would falsely reject a
// fresh re-login minted in the same second as the logout cutoff. The <1s same-
// second window is closed by revokeRefreshTokens + the ≤1h token expiry.
export const checkUserRow = (issuedAtMs: number, row: UserRow | undefined | null): User | null => {
  if (!isUserActive(row)) return null
  const issuedSec = Math.floor(issuedAtMs / 1000)
  const validAfterSec = Math.floor(row.tokensValidAfter.getTime() / 1000)
  if (issuedSec < validAfterSec) return null
  return rowToUser(row)
}

// Sentinel so a cached "no session" survives nullish checks.
const NO_SESSION = Symbol('no-session')
type CachedSession = User | typeof NO_SESSION
interface SessionContext {
  __session?: CachedSession
  // True when the session was resolved from a `grg_` API token (not an interactive Firebase
  // login). Token-management endpoints reject these so a token can't mint or revoke tokens.
  __viaApiToken?: boolean
}

// Reads the Firebase ID token from `Authorization: Bearer`, verifies it, and
// resolves the matching user row. Anonymous-friendly: returns null instead of
// throwing. Result is cached per-request on event.context.
export const getSessionUser = async (event: H3Event): Promise<User | null> => {
  const ctx = event.context as SessionContext
  if (ctx.__session !== undefined) return ctx.__session === NO_SESSION ? null : ctx.__session

  const reject = () => {
    ctx.__session = NO_SESSION
    return null
  }

  const token = extractBearerToken(getHeader(event, 'authorization'))
  if (!token) return reject()

  // Third-party API tokens (`grg_…`) resolve against the durable token table, not
  // Firebase. They deliberately bypass the tokensValidAfter logout cutoff — only a
  // banned/deleted owner or an explicit token DELETE revokes them.
  if (token.startsWith(API_TOKEN_PREFIX)) {
    const secret = useRuntimeConfig().internalApiSecret
    if (!secret) return reject()
    // One round-trip: the token row joined to its owner. Ban/delete/role changes take effect
    // immediately (owner re-read every request); only the logout cutoff is deliberately bypassed.
    const found = await findApiTokenWithOwner(hashApiToken(token, secret))
    if (!found || !isUserActive(found.owner)) return reject()
    const apiUser = rowToUser(found.owner)
    ctx.__session = apiUser
    ctx.__viaApiToken = true
    void touchApiTokenLastUsed(found.tokenId)
    return apiUser
  }

  let uid: string
  let issuedAtMs: number
  try {
    const decoded = await verifyIdToken(token)
    uid = decoded.uid
    issuedAtMs = decoded.iat * 1000
  } catch {
    return reject()
  }

  const row = await db.selectFrom('users').selectAll().where('id', '=', uid).executeTakeFirst()
  const user = checkUserRow(issuedAtMs, row)
  if (!user) return reject()

  ctx.__session = user
  return user
}

export const requireSession = async (event: H3Event): Promise<User> => {
  const user = await getSessionUser(event)
  if (!user) throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
  return user
}

export const requireAdmin = async (event: H3Event): Promise<User> => {
  const user = await requireSession(event)
  if (!user.roles.includes(UserRole.admin)) throw createError({ statusCode: 403, statusMessage: 'Admin only' })
  return user
}

// For endpoints that manage API tokens themselves: block `grg_` token sessions so a leaked
// token can't mint or revoke tokens (privilege self-replication). Interactive Firebase admins only.
export const requireInteractiveAdmin = async (event: H3Event): Promise<User> => {
  const user = await requireAdmin(event)
  if ((event.context as SessionContext).__viaApiToken) {
    throw createError({ statusCode: 403, statusMessage: 'API tokens cannot manage API tokens' })
  }
  return user
}

// Constant-time compare. timingSafeEqual throws on unequal-length buffers (which would
// leak length), so hash both to a fixed 32 bytes first.
const safeEqual = (a: string, b: string): boolean =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())

// Auth for scheduler-triggered endpoints (no Firebase user): a shared secret in the
// Authorization header, compared in constant time. 503 if unconfigured, 401 on mismatch.
export const requireCronSecret = (event: H3Event): void => {
  const secret = useRuntimeConfig().cronSecret
  if (!secret) throw createError({ statusCode: 503, statusMessage: 'Cron not configured' })
  const token = extractBearerToken(getHeader(event, 'authorization'))
  if (!token || !safeEqual(token, secret)) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
}
