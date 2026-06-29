import { randomUUID } from 'node:crypto'
import { db } from '../utils/db'
import { apiTokenRowToModel, type ApiTokenJoinRow } from './mappers'
import { apiTokenDisplayPrefix, generateApiToken, hashApiToken } from '../utils/apiToken'
import { paginate, type PageParams } from '../utils/pagination'
import type { UserRow } from '../db/schema'
import type { ApiTokenCreated, ApiTokenRow, Paginated } from '~/models'

export const listApiTokens = (params: PageParams): Promise<Paginated<ApiTokenRow>> =>
  // leftJoin so a deleted creator still lists the token; it's 1:1 on users.id (PK), so paginate's
  // count over the joined base still equals the token count. The projection adds createdByName,
  // which paginate can't see in the row type — cast to the join-row shape the mapper expects.
  paginate(
    db.selectFrom('apiTokens').leftJoin('users', 'users.id', 'apiTokens.createdBy'),
    qb => qb.orderBy('apiTokens.createdAt', 'desc'),
    rows => (rows as unknown as ApiTokenJoinRow[]).map(apiTokenRowToModel),
    params,
    qb =>
      qb.select([
        'apiTokens.id',
        'apiTokens.name',
        'apiTokens.tokenPrefix',
        'apiTokens.createdBy',
        'apiTokens.createdAt',
        'apiTokens.lastUsedAt',
        'users.fullName as createdByName',
      ]),
  )

export const createApiToken = async (
  input: { name: string; createdBy: string; createdByName: string | null },
  secret: string,
): Promise<ApiTokenCreated> => {
  const token = generateApiToken()
  const inserted = await db
    .insertInto('apiTokens')
    .values({
      id: randomUUID(),
      name: input.name,
      tokenHash: hashApiToken(token, secret),
      tokenPrefix: apiTokenDisplayPrefix(token),
      createdBy: input.createdBy,
    })
    .returning(['id', 'name', 'tokenPrefix', 'createdBy', 'createdAt', 'lastUsedAt'])
    .executeTakeFirstOrThrow()
  // The creator is the acting admin, so their display name is already known — no follow-up join.
  return { token, row: apiTokenRowToModel({ ...inserted, createdByName: input.createdByName }) }
}

export const deleteApiToken = async (id: string): Promise<boolean> => {
  const res = await db.deleteFrom('apiTokens').where('id', '=', id).executeTakeFirst()
  return Number(res.numDeletedRows) > 0
}

// Token + its owner in one query (the FK guarantees the owner row exists). The session resolver
// runs this on every API-token request, so it returns the full user row to gate and build the session.
export const findApiTokenWithOwner = async (hash: string): Promise<{ tokenId: string; owner: UserRow } | undefined> => {
  const row = await db
    .selectFrom('apiTokens')
    .innerJoin('users', 'users.id', 'apiTokens.createdBy')
    .selectAll('users')
    .select('apiTokens.id as tokenId')
    .where('apiTokens.tokenHash', '=', hash)
    .executeTakeFirst()
  if (!row) return undefined
  const { tokenId, ...owner } = row
  return { tokenId, owner: owner as UserRow }
}

// last_used_at is best-effort telemetry written on every authenticated request.
// Throttle per token to ~1 write/min so a busy integration can't hammer the DB.
const lastTouch = new Map<string, number>()
const TOUCH_THROTTLE_MS = 60_000

export const touchApiTokenLastUsed = async (id: string): Promise<void> => {
  const now = Date.now()
  const prev = lastTouch.get(id)
  if (prev && now - prev < TOUCH_THROTTLE_MS) return
  lastTouch.set(id, now)
  await db.updateTable('apiTokens').set({ lastUsedAt: new Date() }).where('id', '=', id).execute()
}
