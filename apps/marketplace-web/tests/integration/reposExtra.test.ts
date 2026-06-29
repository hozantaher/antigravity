import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { db } from '~/server/utils/db'
import * as userRepo from '~/server/repos/userRepo'
import * as apiTokenRepo from '~/server/repos/apiTokenRepo'
import { hashApiToken } from '~/server/utils/apiToken'
import { getCachedVinDecode, insertVinDecodeCache } from '~/server/repos/vinDecodeRepo'

const RUN = !!process.env.POSTGRES_URL
const UID = 'itest-extra-u1'
const SECRET = 'test-pepper'
const VIN = 'ITEST00000000VIN1'
const VIN_NULL = 'ITEST00000000VIN2'
const PAGE = { page: 1, pageSize: 100, limit: 100, offset: 0 }

const cleanup = async () => {
  await db.deleteFrom('apiTokens').where('createdBy', 'like', 'itest-extra-%').execute()
  await db.deleteFrom('vinDecodeCache').where('vin', 'in', [VIN, VIN_NULL]).execute()
  await db.deleteFrom('users').where('id', 'like', 'itest-extra-%').execute()
}

describe.skipIf(!RUN)('repos extra (Postgres)', () => {
  beforeAll(async () => {
    await cleanup()
    await userRepo.createOrGetUser({ uid: UID, email: 'extra@example.test', name: 'Extra' })
  })
  afterAll(cleanup)

  describe('apiTokenRepo', () => {
    it('creates, finds by hash, lists, and deletes a token', async () => {
      const { token, row } = await apiTokenRepo.createApiToken(
        { name: 'CI', createdBy: UID, createdByName: 'Extra' },
        SECRET,
      )
      expect(token.startsWith('grg_')).toBe(true)

      const found = await apiTokenRepo.findApiTokenWithOwner(hashApiToken(token, SECRET))
      expect(found?.owner.id).toBe(UID)
      await apiTokenRepo.touchApiTokenLastUsed(found!.tokenId)

      const page = await apiTokenRepo.listApiTokens(PAGE)
      expect(page.items.some(t => t.id === row.id)).toBe(true)

      expect(await apiTokenRepo.deleteApiToken(row.id)).toBe(true)
      expect(await apiTokenRepo.deleteApiToken(row.id)).toBe(false)
    })
  })

  describe('vinDecodeRepo', () => {
    it('inserts and reads a cached decode, idempotent on conflict', async () => {
      await insertVinDecodeCache({
        vin: VIN,
        normalized: { manufacturer: 'Audi' } as never,
        rawResponse: { decode: [] } as never,
        price: 5,
        priceCurrency: 'EUR',
        decodedBy: UID,
      })
      await insertVinDecodeCache({
        vin: VIN,
        normalized: { manufacturer: 'BMW' } as never,
        rawResponse: { decode: [] } as never,
        price: 9,
        priceCurrency: 'EUR',
        decodedBy: UID,
      })
      const cached = await getCachedVinDecode(VIN.toLowerCase())
      expect(cached?.normalized).toMatchObject({ manufacturer: 'Audi' }) // first write wins
      expect(cached?.priceCurrency).toBe('EUR')
    })

    it('stores null price/currency/decodedBy', async () => {
      await insertVinDecodeCache({
        vin: VIN_NULL.toLowerCase(),
        normalized: { manufacturer: 'Skoda' } as never,
        rawResponse: { decode: [] } as never,
        price: null,
        priceCurrency: null,
        decodedBy: null,
      })
      const cached = await getCachedVinDecode(VIN_NULL)
      expect(cached?.vin).toBe(VIN_NULL)
      expect(cached?.price).toBeNull()
      expect(cached?.priceCurrency).toBeNull()
    })

    it('returns undefined for an unknown vin', async () => {
      expect(await getCachedVinDecode('ITEST-NO-SUCH-VIN')).toBeUndefined()
    })
  })

  describe('userRepo extras', () => {
    it('updates a whitelisted profile and reads by ids', async () => {
      const updated = await userRepo.updateUserProfile(UID, {
        fullName: 'Renamed',
        phone: '+420111',
        language: { code: 'en' } as never,
      })
      expect(updated?.fullName).toBe('Renamed')
      expect((await userRepo.getByIds([UID])).map(u => u.id)).toContain(UID)
    })

    it('syncs auth fields and surfaces in admin search', async () => {
      const synced = await userRepo.syncAuthFields(UID, { email: 'synced@example.test', emailVerified: true })
      expect(synced?.email).toBe('synced@example.test')
      const page = await userRepo.listAdminUsersPage({}, PAGE)
      expect(page.items.some(u => u.id === UID)).toBe(true)
    })

    it('moves the logout cutoff then soft-deletes', async () => {
      const cutoff = new Date()
      await userRepo.setTokensValidAfter(UID, cutoff)
      const row = await db.selectFrom('users').select(['tokensValidAfter']).where('id', '=', UID).executeTakeFirst()
      expect(row?.tokensValidAfter.getTime()).toBe(cutoff.getTime())

      await userRepo.softDeleteUser(UID)
      const deleted = await db.selectFrom('users').select(['deletedAt']).where('id', '=', UID).executeTakeFirst()
      expect(deleted?.deletedAt).not.toBeNull()
    })
  })

  describe('apiTokenRepo branches', () => {
    it('returns undefined for an unknown token hash', async () => {
      expect(await apiTokenRepo.findApiTokenWithOwner('itest-extra-no-such-hash')).toBeUndefined()
    })

    it('lists a token whose creator was soft-deleted (leftJoin null name)', async () => {
      const orphanUid = 'itest-extra-orphan'
      await userRepo.createOrGetUser({ uid: orphanUid, email: 'orphan@example.test', name: 'Orphan' })
      const { row } = await apiTokenRepo.createApiToken(
        { name: 'Orphaned', createdBy: orphanUid, createdByName: 'Orphan' },
        SECRET,
      )
      // listApiTokens projects users.fullName; soft-delete renames it but the join still resolves.
      await userRepo.softDeleteUser(orphanUid)
      const page = await apiTokenRepo.listApiTokens(PAGE)
      const listed = page.items.find(t => t.id === row.id)
      expect(listed).toBeDefined()
      expect(listed?.createdBy).toBe(orphanUid)
    })

    it('throttles last-used touches to one write per window', async () => {
      const touchUid = 'itest-extra-touch'
      await userRepo.createOrGetUser({ uid: touchUid, email: 'touch@example.test', name: 'Touch' })
      const { row } = await apiTokenRepo.createApiToken(
        { name: 'Touchy', createdBy: touchUid, createdByName: 'Touch' },
        SECRET,
      )

      await apiTokenRepo.touchApiTokenLastUsed(row.id)
      const first = await db.selectFrom('apiTokens').select(['lastUsedAt']).where('id', '=', row.id).executeTakeFirst()
      expect(first?.lastUsedAt).not.toBeNull()

      // Immediate second call hits the in-process throttle and must not rewrite.
      await apiTokenRepo.touchApiTokenLastUsed(row.id)
      const second = await db.selectFrom('apiTokens').select(['lastUsedAt']).where('id', '=', row.id).executeTakeFirst()
      expect(second?.lastUsedAt?.getTime()).toBe(first?.lastUsedAt?.getTime())
    })
  })

  describe('userRepo branches', () => {
    const PUID = 'itest-extra-probe'

    it('createOrGetUser inserts (provider mapping) then returns the existing row', async () => {
      const created = await userRepo.createOrGetUser(
        { uid: PUID, email: 'probe@example.test', name: 'Probe', signInProvider: 'google.com', emailVerified: true },
        { fullName: 'Probe Full', phone: '+420999', newsletter: true, language: { code: 'de' } as never },
      )
      expect(created.id).toBe(PUID)
      expect(created.fullName).toBe('Probe Full')

      // Second call short-circuits on the existing row (does not re-insert / overwrite).
      const again = await userRepo.createOrGetUser({
        uid: PUID,
        email: 'changed@example.test',
        name: 'Changed',
        signInProvider: 'facebook.com',
      })
      expect(again.fullName).toBe('Probe Full')
      expect(again.email).toBe('probe@example.test')
    })

    it('createOrGetUser falls back to email/User name when no profile/name given', async () => {
      const emailOnly = 'itest-extra-emailonly'
      const u1 = await userRepo.createOrGetUser({ uid: emailOnly, email: 'only@example.test' })
      expect(u1.fullName).toBe('only@example.test')

      const noName = 'itest-extra-noname'
      const u2 = await userRepo.createOrGetUser({ uid: noName })
      expect(u2.fullName).toBe('User')
      expect(u2.email).toBe('')
    })

    it('getByEmail matches case-insensitively and misses unknown', async () => {
      const found = await userRepo.getByEmail('PROBE@EXAMPLE.TEST')
      expect(found?.id).toBe(PUID)
      expect(await userRepo.getByEmail('itest-extra-nobody@nope.test')).toBeUndefined()
    })

    it('getByIds returns empty for an empty id list', async () => {
      expect(await userRepo.getByIds([])).toEqual([])
    })

    it('getById returns undefined for an unknown id', async () => {
      expect(await userRepo.getById('itest-extra-no-such-user')).toBeUndefined()
    })

    it('createOrGetUser maps the facebook provider on first insert', async () => {
      const fbUid = 'itest-extra-fb'
      await userRepo.createOrGetUser({
        uid: fbUid,
        email: 'fb@example.test',
        name: 'FB',
        signInProvider: 'facebook.com',
      })
      const row = await db.selectFrom('users').select(['authType']).where('id', '=', fbUid).executeTakeFirst()
      expect(row?.authType).toBe('facebook')
    })

    it('updateUserProfile with an empty patch is a no-op read; whitelist ignores role/email', async () => {
      const before = await userRepo.getById(PUID)
      const noop = await userRepo.updateUserProfile(PUID, {})
      expect(noop?.email).toBe(before?.email)

      // Crafted body: role/email are NOT in the whitelist and must be ignored.
      await userRepo.updateUserProfile(PUID, {
        fullName: 'Whitelisted Only',
        email: 'hacker@evil.test',
        roles: ['admin'],
      } as never)
      const after = await db
        .selectFrom('users')
        .select(['email', 'roles', 'fullName'])
        .where('id', '=', PUID)
        .executeTakeFirst()
      expect(after?.fullName).toBe('Whitelisted Only')
      expect(after?.email).toBe('probe@example.test')
      expect(after?.roles).toEqual(['user'])
    })

    it('updateUserProfile clears nullable fields and persists newsletter/language', async () => {
      const updated = await userRepo.updateUserProfile(PUID, {
        phone: null,
        companyName: null,
        companyVatNumber: null,
        companyIdNumber: null,
        bankAccount: null,
        address: null,
        newsletter: true,
        language: undefined,
      } as never)
      expect(updated?.phone ?? null).toBeNull()
      expect(updated?.newsletter).toBe(true)
    })

    it('syncAuthFields: missing user, no-op when unchanged, and applies drift', async () => {
      expect(await userRepo.syncAuthFields('itest-extra-ghost', { email: 'x@y.test' })).toBeUndefined()

      const row = await db
        .selectFrom('users')
        .select(['email', 'emailVerified'])
        .where('id', '=', PUID)
        .executeTakeFirst()
      // Same email + same verified flag → no DB write, returns the current row mapping.
      const noop = await userRepo.syncAuthFields(PUID, {
        email: row?.email,
        emailVerified: row?.emailVerified,
      })
      expect(noop?.id).toBe(PUID)

      const drifted = await userRepo.syncAuthFields(PUID, {
        email: 'drift@example.test',
        emailVerified: !row?.emailVerified,
      })
      expect(drifted?.email).toBe('drift@example.test')
    })

    it('toggleFavorite adds then removes; missing user starts from empty', async () => {
      const added = await userRepo.toggleFavorite(PUID, 'fav-item-1')
      expect(added).toContain('fav-item-1')
      const removed = await userRepo.toggleFavorite(PUID, 'fav-item-1')
      expect(removed).not.toContain('fav-item-1')

      // No such user → row is undefined → current defaults to [] → toggle adds the id.
      const ghost = await userRepo.toggleFavorite('itest-extra-fav-ghost', 'fav-x')
      expect(ghost).toEqual(['fav-x'])
    })

    it('grantRole: missing user false, new role true, idempotent re-grant true', async () => {
      expect(await userRepo.grantRole('itest-extra-role-ghost', 'admin')).toBe(false)

      expect(await userRepo.grantRole(PUID, 'admin')).toBe(true)
      const granted = await db.selectFrom('users').select(['roles']).where('id', '=', PUID).executeTakeFirst()
      expect(granted?.roles).toContain('admin')

      // Already has the role → returns true without a second write.
      expect(await userRepo.grantRole(PUID, 'admin')).toBe(true)
    })

    it('listAdminUsersPage filters by free-text q across fields', async () => {
      const page = await userRepo.listAdminUsersPage({ q: PUID }, PAGE)
      expect(page.items.some(u => u.id === PUID)).toBe(true)
      const blank = await userRepo.listAdminUsersPage({ q: '   ' }, PAGE)
      expect(Array.isArray(blank.items)).toBe(true)
    })
  })
})
