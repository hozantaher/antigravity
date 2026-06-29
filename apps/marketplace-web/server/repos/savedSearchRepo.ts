import { sql } from 'kysely'
import type { Paginated, SavedSearch, SearchQuery } from '~/models'
import { db } from '../utils/db'
import { paginate, type PageParams } from '../utils/pagination'
import { rowToSavedSearch, savedSearchCreateToInsert, savedSearchPatchToUpdate } from './mappers'
import type { SavedSearchCreateBody } from './mappers'

// Owner-scoped CRUD + alert queries for saved searches. The query is jsonb (a SearchQuery object —
// no array, so no jsonbArray gotcha). Per-search alert CAS lives on last_alerted_at.

// The caller's saved searches, newest first, paginated.
export const listForUser = (userId: string, params: PageParams): Promise<Paginated<SavedSearch>> =>
  paginate(
    db.selectFrom('savedSearches').where('userId', '=', userId),
    qb => qb.orderBy('createdAt', 'desc').orderBy('id', 'desc'),
    rows => rows.map(rowToSavedSearch),
    params,
  )

// One saved search, only if it belongs to the user. Cross-user lookups return undefined → the API
// maps that to 404 (never 403), so a row's existence doesn't leak.
export const getOwned = async (id: string, userId: string): Promise<SavedSearch | undefined> => {
  const row = await db
    .selectFrom('savedSearches')
    .selectAll()
    .where('id', '=', id)
    .where('userId', '=', userId)
    .executeTakeFirst()
  return row ? rowToSavedSearch(row) : undefined
}

// Current count for the per-user cap check.
export const countForUser = async (userId: string): Promise<number> => {
  const row = await db
    .selectFrom('savedSearches')
    .select(eb => eb.fn.countAll<string>().as('total'))
    .where('userId', '=', userId)
    .executeTakeFirstOrThrow()
  return Number(row.total)
}

export const create = async (id: string, userId: string, body: SavedSearchCreateBody): Promise<SavedSearch> => {
  const row = await db
    .insertInto('savedSearches')
    .values(savedSearchCreateToInsert(id, userId, body))
    .returningAll()
    .executeTakeFirstOrThrow()
  return rowToSavedSearch(row)
}

// Owner-scoped patch via the name/alertEnabled whitelist. Bumps updatedAt. Returns the updated row,
// or undefined when nothing matched (wrong owner / gone) → 404. An empty whitelist still bumps
// updatedAt and returns the current row (idempotent no-op patch), never a silent 404.
export const update = async (
  id: string,
  userId: string,
  patch: { name?: unknown; alertEnabled?: unknown },
): Promise<SavedSearch | undefined> => {
  const row = await db
    .updateTable('savedSearches')
    .set({ ...savedSearchPatchToUpdate(patch), updatedAt: new Date() })
    .where('id', '=', id)
    .where('userId', '=', userId)
    .returningAll()
    .executeTakeFirst()
  return row ? rowToSavedSearch(row) : undefined
}

// Owner-scoped delete. Returns whether a row was removed (false → 404).
export const remove = async (id: string, userId: string): Promise<boolean> => {
  const res = await db.deleteFrom('savedSearches').where('id', '=', id).where('userId', '=', userId).executeTakeFirst()
  return Number(res.numDeletedRows ?? 0) > 0
}

// One-click unsubscribe / alert toggle by id alone (the HMAC token already authorized it). Not
// owner-scoped — the token signs the saved-search id, so it disables that one alert without a login.
export const setAlertEnabled = async (id: string, enabled: boolean): Promise<void> => {
  await db
    .updateTable('savedSearches')
    .set({ alertEnabled: enabled, updatedAt: new Date() })
    .where('id', '=', id)
    .execute()
}

export interface DueAlertSearch {
  id: string
  userId: string
  name: string
  query: SearchQuery
  email: string
  languageCode: string | null
}

// Saved searches whose alert is due: alert-enabled, last alerted before the cutoff (or never), joined
// to a verified, non-deleted owner (parity with listDueNewsletterUsers). Never-alerted first
// (nulls first), capped — overflow waits for the next run. The join drops searches whose owner opted
// out by deletion / lost email verification.
export const listDueAlertSearches = (cutoffMs: number, limit: number): Promise<DueAlertSearch[]> =>
  db
    .selectFrom('savedSearches')
    .innerJoin('users', 'users.id', 'savedSearches.userId')
    .select([
      'savedSearches.id as id',
      'savedSearches.userId as userId',
      'savedSearches.name as name',
      'savedSearches.query as query',
      'users.email as email',
      'users.languageCode as languageCode',
    ])
    .where('savedSearches.alertEnabled', '=', true)
    .where('users.emailVerified', '=', true)
    .where('users.deletedAt', 'is', null)
    .where(eb =>
      eb.or([
        eb('savedSearches.lastAlertedAt', 'is', null),
        eb('savedSearches.lastAlertedAt', '<', new Date(cutoffMs)),
      ]),
    )
    .orderBy(sql`saved_searches.last_alerted_at asc nulls first`)
    .limit(limit)
    .execute()

/**
 * Claim a saved-search alert by stamping last_alerted_at = now() only while it is still due (CAS).
 * A losing concurrent run gets `false` and skips → no double-send. Disabled rows can't be claimed.
 */
export const claimAlertSend = async (searchId: string, cutoffMs: number): Promise<boolean> => {
  const res = await db
    .updateTable('savedSearches')
    .set({ lastAlertedAt: new Date() })
    .where('id', '=', searchId)
    .where('alertEnabled', '=', true)
    .where(eb => eb.or([eb('lastAlertedAt', 'is', null), eb('lastAlertedAt', '<', new Date(cutoffMs))]))
    .executeTakeFirst()
  return Number(res.numUpdatedRows ?? 0) > 0
}
