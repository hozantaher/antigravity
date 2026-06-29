import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { db } from '~/server/utils/db'
import { listDueNewsletterUsers, claimNewsletterSend, setNewsletterEnabled } from '~/server/repos/newsletterRepo'

const RUN = !!process.env.POSTGRES_URL
const PREFIX = 'itest-nl-'
const DAY = 86_400_000

// Cutoff = "due if last send is older than 7 days ago".
const cutoffMs = Date.now() - 7 * DAY

const seedUser = async (
  suffix: string,
  overrides: {
    newsletter?: boolean
    emailVerified?: boolean
    deletedAt?: Date | null
    languageCode?: string | null
    newsletterLastSentAt?: Date | null
  } = {},
) => {
  const id = `${PREFIX}${suffix}`
  await db
    .insertInto('users')
    .values({
      id,
      authType: 'email',
      fullName: `NL ${suffix}`,
      email: `${id}@example.test`,
      newsletter: overrides.newsletter ?? true,
      emailVerified: overrides.emailVerified ?? true,
      deletedAt: overrides.deletedAt ?? null,
      languageCode: 'languageCode' in overrides ? (overrides.languageCode ?? null) : 'cz',
      newsletterLastSentAt: overrides.newsletterLastSentAt ?? null,
    })
    .execute()
  return id
}

const cleanup = async () => {
  await db.deleteFrom('users').where('id', 'like', `${PREFIX}%`).execute()
}

const dueIds = async (): Promise<string[]> => {
  // Scope to our own rows — other files share the DB, never assert on global counts.
  const rows = await listDueNewsletterUsers(cutoffMs, 1000)
  return rows.filter(r => r.id.startsWith(PREFIX)).map(r => r.id)
}

describe.skipIf(!RUN)('newsletterRepo (Postgres)', () => {
  beforeAll(cleanup)
  afterAll(cleanup)

  describe('listDueNewsletterUsers', () => {
    it('returns never-sent and stale users, ordered never-sent first', async () => {
      const never = await seedUser('never', { newsletterLastSentAt: null })
      const stale = await seedUser('stale', { newsletterLastSentAt: new Date(cutoffMs - DAY) })

      const rows = (await listDueNewsletterUsers(cutoffMs, 1000)).filter(r => r.id.startsWith(PREFIX))
      const ids = rows.map(r => r.id)
      expect(ids).toContain(never)
      expect(ids).toContain(stale)

      // never-sent (nulls first) precedes the stale row in our subset.
      expect(rows.findIndex(r => r.id === never)).toBeLessThan(rows.findIndex(r => r.id === stale))

      const neverRow = rows.find(r => r.id === never)
      expect(neverRow?.email).toBe(`${never}@example.test`)
      expect(neverRow?.languageCode).toBe('cz')
    })

    it('excludes recently-sent, opted-out, unverified, and soft-deleted users', async () => {
      const recent = await seedUser('recent', { newsletterLastSentAt: new Date(cutoffMs + DAY) })
      const optedOut = await seedUser('optout', { newsletter: false })
      const unverified = await seedUser('unverified', { emailVerified: false })
      const deleted = await seedUser('deleted', { deletedAt: new Date() })

      const ids = await dueIds()
      expect(ids).not.toContain(recent)
      expect(ids).not.toContain(optedOut)
      expect(ids).not.toContain(unverified)
      expect(ids).not.toContain(deleted)
    })

    it('boundary: a send exactly at the cutoff is NOT due (strict <)', async () => {
      const atCutoff = await seedUser('atcutoff', { newsletterLastSentAt: new Date(cutoffMs) })
      const ids = await dueIds()
      expect(ids).not.toContain(atCutoff)
    })

    it('honours the limit', async () => {
      await seedUser('lim1', { newsletterLastSentAt: null })
      await seedUser('lim2', { newsletterLastSentAt: null })
      const rows = await listDueNewsletterUsers(cutoffMs, 1)
      expect(rows.length).toBe(1)
    })

    it('null languageCode flows through', async () => {
      const id = await seedUser('nolang', { languageCode: null, newsletterLastSentAt: null })
      const rows = (await listDueNewsletterUsers(cutoffMs, 1000)).filter(r => r.id === id)
      expect(rows[0]?.languageCode).toBeNull()
    })
  })

  describe('claimNewsletterSend', () => {
    it('claims a due user once, then refuses the replay (CAS prevents double-send)', async () => {
      const id = await seedUser('claim', { newsletterLastSentAt: null })

      const first = await claimNewsletterSend(id, cutoffMs)
      expect(first).toBe(true)

      // The stamp is now() — no longer due, so the second claim loses.
      const second = await claimNewsletterSend(id, cutoffMs)
      expect(second).toBe(false)

      // After claiming, the user drops out of the due set.
      const ids = await dueIds()
      expect(ids).not.toContain(id)
    })

    it('claims a stale user (last send older than the cutoff)', async () => {
      const id = await seedUser('claimstale', { newsletterLastSentAt: new Date(cutoffMs - DAY) })
      expect(await claimNewsletterSend(id, cutoffMs)).toBe(true)
    })

    it('refuses a recently-sent user', async () => {
      const id = await seedUser('claimrecent', { newsletterLastSentAt: new Date(cutoffMs + DAY) })
      expect(await claimNewsletterSend(id, cutoffMs)).toBe(false)
    })

    it('returns false for an unknown user id', async () => {
      expect(await claimNewsletterSend(`${PREFIX}missing-xyz`, cutoffMs)).toBe(false)
    })
  })

  describe('setNewsletterEnabled', () => {
    it('toggles the newsletter flag off then on, affecting due eligibility', async () => {
      const id = await seedUser('toggle', { newsletter: true, newsletterLastSentAt: null })
      expect(await dueIds()).toContain(id)

      await setNewsletterEnabled(id, false)
      expect(await dueIds()).not.toContain(id)
      const off = await db.selectFrom('users').select('newsletter').where('id', '=', id).executeTakeFirst()
      expect(off?.newsletter).toBe(false)

      await setNewsletterEnabled(id, true)
      expect(await dueIds()).toContain(id)
    })

    it('is a no-op for an unknown user id', async () => {
      await expect(setNewsletterEnabled(`${PREFIX}missing-set`, true)).resolves.toBeUndefined()
    })
  })
})
