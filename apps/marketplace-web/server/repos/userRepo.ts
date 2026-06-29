import { sql } from 'kysely'
import type { Paginated, RegisterProfile, User } from '~/models'
import { db } from '../utils/db'
import type { UserInsert, UserRow, UserUpdate } from '../db/schema'
import { rowToUser, userProfilePatchToUpdate } from './mappers'
import { paginate, type PageParams } from '../utils/pagination'
import { unaccentLikeAny } from '../utils/search'

const getRowById = (id: string): Promise<UserRow | undefined> =>
  db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst()

export const getById = async (id: string): Promise<User | undefined> => {
  const row = await getRowById(id)
  return row ? rowToUser(row) : undefined
}

export const getByIds = async (ids: string[]): Promise<User[]> => {
  if (ids.length === 0) return []
  const rows = await db.selectFrom('users').selectAll().where('id', 'in', ids).execute()
  return rows.map(rowToUser)
}

export const getByEmail = async (email: string): Promise<User | undefined> => {
  const row = await db
    .selectFrom('users')
    .selectAll()
    .where(eb => eb(eb.fn('lower', ['email']), '=', email.toLowerCase()))
    .executeTakeFirst()
  return row ? rowToUser(row) : undefined
}

// Admin user list. Free-text q matches name/email/phone/id + the JSONB country name
// (diacritics-folded via unaccent). created desc + id tie-break keeps paging stable.
export const listAdminUsersPage = (filter: { q?: string }, params: PageParams): Promise<Paginated<User>> => {
  let base = db.selectFrom('users')
  const q = filter.q?.trim()
  if (q) {
    const targets = [
      sql.ref('full_name'),
      sql.ref('email'),
      sql.ref('phone'),
      sql.ref('id'),
      sql`address->'country'->>'name'`,
    ]
    base = base.where(eb => eb.or(unaccentLikeAny(targets, q)))
  }
  return paginate(
    base,
    qb => qb.orderBy(sql`created desc`).orderBy(sql`id asc`),
    rows => rows.map(rowToUser),
    params,
  )
}

export interface FirebaseClaims {
  uid: string
  email?: string
  name?: string
  emailVerified?: boolean
  signInProvider?: string
}

const mapProvider = (signInProvider: string | undefined): UserInsert['authType'] =>
  signInProvider === 'google.com' ? 'google' : signInProvider === 'facebook.com' ? 'facebook' : 'email'

// Upsert by Firebase UID. First verified login creates the row; later logins return it.
export const createOrGetUser = async (claims: FirebaseClaims, profile?: RegisterProfile): Promise<User> => {
  const existing = await getRowById(claims.uid)
  if (existing) return rowToUser(existing)

  const insert: UserInsert = {
    id: claims.uid,
    authType: mapProvider(claims.signInProvider),
    fullName: profile?.fullName ?? claims.name ?? claims.email ?? 'User',
    email: claims.email ?? '',
    phone: profile?.phone ?? null,
    companyName: profile?.companyName ?? null,
    companyVatNumber: profile?.companyVatNumber ?? null,
    companyIdNumber: profile?.companyIdNumber ?? null,
    address: profile?.address ?? null,
    languageCode: profile?.language?.code ?? 'cz',
    newsletter: profile?.newsletter ?? false,
    emailVerified: claims.emailVerified ?? false,
    roles: ['user'],
    depositBalanceAmount: 0,
    depositBalanceCurrency: 'EUR',
  }
  // ON CONFLICT DO NOTHING guards the race where two requests arrive before the first insert commits.
  await db
    .insertInto('users')
    .values(insert)
    .onConflict(oc => oc.column('id').doNothing())
    .execute()
  const row = await getRowById(claims.uid)
  return rowToUser(row!)
}

// Persist self-editable profile fields. The whitelist lives in the mapper so a
// crafted body can't touch email/roles/deposit. No-ops (empty patch) skip the
// write and just re-read.
export const updateUserProfile = async (userId: string, patch: Partial<User>): Promise<User | undefined> => {
  const update = userProfilePatchToUpdate(patch)
  if (Object.keys(update).length > 0) {
    await db.updateTable('users').set(update).where('id', '=', userId).execute()
  }
  return getById(userId)
}

// Firebase owns the email + verification status; mirror any drift into our row
// on login so emailVerified reflects reality after the user confirms a link.
export const syncAuthFields = async (
  userId: string,
  fields: { email?: string; emailVerified?: boolean },
): Promise<User | undefined> => {
  const row = await getRowById(userId)
  if (!row) return undefined
  const patch: UserUpdate = {}
  if (fields.email && fields.email !== row.email) patch.email = fields.email
  if (fields.emailVerified !== undefined && fields.emailVerified !== row.emailVerified) {
    patch.emailVerified = fields.emailVerified
  }
  if (Object.keys(patch).length === 0) return rowToUser(row)
  await db.updateTable('users').set(patch).where('id', '=', userId).execute()
  const fresh = await getRowById(userId)
  return rowToUser(fresh!)
}

export const toggleFavorite = async (userId: string, itemId: string): Promise<string[]> => {
  const row = await db.selectFrom('users').select('favoriteIds').where('id', '=', userId).executeTakeFirst()
  const current = row?.favoriteIds ?? []
  const set = new Set(current)
  if (set.has(itemId)) set.delete(itemId)
  else set.add(itemId)
  const favoriteIds = [...set]
  await db.updateTable('users').set({ favoriteIds }).where('id', '=', userId).execute()
  return favoriteIds
}

export const setTokensValidAfter = async (userId: string, at: Date): Promise<void> => {
  await db.updateTable('users').set({ tokensValidAfter: at }).where('id', '=', userId).execute()
}

// Account deletion: anonymize the row, revoke tokens, and free the e-mail. The row
// is kept (not dropped) because bids/items reference it via ON DELETE RESTRICT.
export const softDeleteUser = async (userId: string): Promise<void> => {
  const now = new Date()
  await db
    .updateTable('users')
    .set({
      deletedAt: now,
      tokensValidAfter: now,
      email: `deleted+${userId}@deleted.invalid`,
      fullName: 'Deleted user',
      phone: null,
      address: null,
      companyName: null,
      companyVatNumber: null,
      companyIdNumber: null,
      bankAccount: null,
      newsletter: false,
      favoriteIds: [],
    })
    .where('id', '=', userId)
    .execute()
}

export const grantRole = async (userId: string, role: string): Promise<boolean> => {
  const row = await db.selectFrom('users').select('roles').where('id', '=', userId).executeTakeFirst()
  if (!row) return false
  if (row.roles.includes(role)) return true
  await db
    .updateTable('users')
    .set({ roles: [...row.roles, role] })
    .where('id', '=', userId)
    .execute()
  return true
}

export const revokeRole = async (userId: string, role: string): Promise<boolean> => {
  const row = await db.selectFrom('users').select('roles').where('id', '=', userId).executeTakeFirst()
  if (!row) return false
  if (!row.roles.includes(role)) return true
  await db
    .updateTable('users')
    .set({ roles: row.roles.filter(r => r !== role) })
    .where('id', '=', userId)
    .execute()
  return true
}
