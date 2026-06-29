import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { db } from '~/server/utils/db'
import * as repo from '~/server/repos/savedSearchRepo'

// Integration: saved-search repo against docker Postgres (:5434). Lives under tests/integration so it
// runs in the integration project (real DB), not the mocked server project. Skipped without POSTGRES_URL.

const RUN = !!process.env.POSTGRES_URL
const PREFIX = 'itest-ss-'
const DAY = 86_400_000
const cutoffMs = Date.now() - 7 * DAY
const PAGE = { page: 1, pageSize: 100, limit: 100, offset: 0 }

const OWNER = `${PREFIX}owner`
const OTHER = `${PREFIX}other`

const seedUser = async (id: string, over: { emailVerified?: boolean; deletedAt?: Date | null } = {}) => {
  await db
    .insertInto('users')
    .values({
      id,
      authType: 'email',
      fullName: `SS ${id}`,
      email: `${id}@example.test`,
      emailVerified: over.emailVerified ?? true,
      deletedAt: over.deletedAt ?? null,
      languageCode: 'cz',
    })
    .onConflict(oc => oc.column('id').doNothing())
    .execute()
}

const cleanupSearches = async () => {
  await db.deleteFrom('savedSearches').where('userId', 'like', `${PREFIX}%`).execute()
}

const cleanup = async () => {
  await cleanupSearches()
  await db.deleteFrom('users').where('id', 'like', `${PREFIX}%`).execute()
}

describe.skipIf(!RUN)('savedSearchRepo (Postgres)', () => {
  beforeAll(async () => {
    await cleanup()
    await seedUser(OWNER)
    await seedUser(OTHER)
  })
  afterAll(cleanup)
  beforeEach(cleanupSearches)

  describe('CRUD + owner scoping', () => {
    it('creates, lists, and reads only the owner’s rows', async () => {
      const created = await repo.create('ss-a', OWNER, { name: 'BMW diesel', query: { q: 'bmw', type: 'auction' } })
      expect(created).toMatchObject({ id: 'ss-a', userId: OWNER, name: 'BMW diesel', alertEnabled: true })
      expect(created.query).toEqual({ q: 'bmw', type: 'auction' })
      expect(created.createdAt).toBeGreaterThan(0)

      const list = await repo.listForUser(OWNER, PAGE)
      expect(list.total).toBe(1)
      expect(list.items[0]?.id).toBe('ss-a')

      // Cross-user read returns undefined (the API maps that to 404).
      expect(await repo.getOwned('ss-a', OTHER)).toBeUndefined()
      expect(await repo.getOwned('ss-a', OWNER)).toMatchObject({ id: 'ss-a' })
    })

    it('normalizes a dirty stored query on read', async () => {
      await db
        .insertInto('savedSearches')
        .values({ id: 'ss-dirty', userId: OWNER, name: 'dirty', query: { type: 'junk', q: 'audi', bogus: 1 } as never })
        .execute()
      const got = await repo.getOwned('ss-dirty', OWNER)
      expect(got?.query).toEqual({ q: 'audi' })
    })

    it('counts per user', async () => {
      await repo.create('ss-c1', OWNER, { name: 'a' })
      await repo.create('ss-c2', OWNER, { name: 'b' })
      expect(await repo.countForUser(OWNER)).toBe(2)
      expect(await repo.countForUser(OTHER)).toBe(0)
    })

    it('updates only the owner’s row via the whitelist and bumps updatedAt', async () => {
      await repo.create('ss-u', OWNER, { name: 'old', query: { q: 'x' } })
      const updated = await repo.update('ss-u', OWNER, { name: 'new', alertEnabled: false })
      expect(updated).toMatchObject({ name: 'new', alertEnabled: false })
      expect(updated?.updatedAt).toBeGreaterThan(0)
      // The query is immutable via patch.
      expect(updated?.query).toEqual({ q: 'x' })

      // Cross-user update matches nothing → undefined (404).
      expect(await repo.update('ss-u', OTHER, { name: 'hijack' })).toBeUndefined()
    })

    it('deletes only the owner’s row', async () => {
      await repo.create('ss-d', OWNER, { name: 'gone' })
      expect(await repo.remove('ss-d', OTHER)).toBe(false) // wrong owner
      expect(await repo.remove('ss-d', OWNER)).toBe(true)
      expect(await repo.remove('ss-d', OWNER)).toBe(false) // already gone
    })
  })

  describe('claimAlertSend (CAS)', () => {
    it('claims a due search once, then refuses the replay', async () => {
      await repo.create('ss-claim', OWNER, { name: 'claim' }) // last_alerted_at NULL → due
      expect(await repo.claimAlertSend('ss-claim', cutoffMs)).toBe(true)
      // Stamp is now() → no longer due, second claim loses.
      expect(await repo.claimAlertSend('ss-claim', cutoffMs)).toBe(false)
    })

    it('refuses to claim a disabled search', async () => {
      await repo.create('ss-off', OWNER, { name: 'off', alertEnabled: false })
      expect(await repo.claimAlertSend('ss-off', cutoffMs)).toBe(false)
    })

    it('returns false for an unknown id', async () => {
      expect(await repo.claimAlertSend(`${PREFIX}missing`, cutoffMs)).toBe(false)
    })
  })

  describe('listDueAlertSearches', () => {
    it('returns enabled, due searches with a verified owner, never-alerted first', async () => {
      await repo.create('ss-never', OWNER, { name: 'never' }) // NULL → due, first
      await db
        .insertInto('savedSearches')
        .values({ id: 'ss-stale', userId: OWNER, name: 'stale', query: {}, lastAlertedAt: new Date(cutoffMs - DAY) })
        .execute()

      const rows = (await repo.listDueAlertSearches(cutoffMs, 1000)).filter(r => r.userId === OWNER)
      const ids = rows.map(r => r.id)
      expect(ids).toContain('ss-never')
      expect(ids).toContain('ss-stale')
      // never-alerted (nulls first) precedes stale.
      expect(rows.findIndex(r => r.id === 'ss-never')).toBeLessThan(rows.findIndex(r => r.id === 'ss-stale'))
      // Joined owner fields are present.
      expect(rows.find(r => r.id === 'ss-never')?.email).toBe(`${OWNER}@example.test`)
    })

    it('excludes disabled, recently-alerted, and rows whose owner is unverified/deleted', async () => {
      await repo.create('ss-disabled', OWNER, { name: 'd', alertEnabled: false })
      await db
        .insertInto('savedSearches')
        .values({ id: 'ss-recent', userId: OWNER, name: 'r', query: {}, lastAlertedAt: new Date(cutoffMs + DAY) })
        .execute()

      const unverified = `${PREFIX}unverified`
      const deleted = `${PREFIX}deleted`
      await seedUser(unverified, { emailVerified: false })
      await seedUser(deleted, { deletedAt: new Date() })
      await repo.create('ss-unverified', unverified, { name: 'u' })
      await repo.create('ss-deleted', deleted, { name: 'x' })

      const ids = (await repo.listDueAlertSearches(cutoffMs, 1000)).map(r => r.id)
      expect(ids).not.toContain('ss-disabled')
      expect(ids).not.toContain('ss-recent')
      expect(ids).not.toContain('ss-unverified')
      expect(ids).not.toContain('ss-deleted')

      await db.deleteFrom('users').where('id', 'in', [unverified, deleted]).execute()
    })

    it('honours the limit', async () => {
      await repo.create('ss-l1', OWNER, { name: '1' })
      await repo.create('ss-l2', OWNER, { name: '2' })
      const rows = await repo.listDueAlertSearches(cutoffMs, 1)
      expect(rows.length).toBe(1)
    })
  })

  describe('setAlertEnabled (token unsubscribe)', () => {
    it('disables the alert by id alone (not owner-scoped)', async () => {
      await repo.create('ss-unsub', OWNER, { name: 'u' })
      await repo.setAlertEnabled('ss-unsub', false)
      expect((await repo.getOwned('ss-unsub', OWNER))?.alertEnabled).toBe(false)
    })
  })

  describe('cascade on user delete', () => {
    it('drops a user’s saved searches when the user is deleted', async () => {
      const temp = `${PREFIX}temp`
      await seedUser(temp)
      await repo.create('ss-cascade', temp, { name: 'c' })
      await db.deleteFrom('users').where('id', '=', temp).execute()
      const gone = await db.selectFrom('savedSearches').select('id').where('id', '=', 'ss-cascade').executeTakeFirst()
      expect(gone).toBeUndefined()
    })
  })
})
