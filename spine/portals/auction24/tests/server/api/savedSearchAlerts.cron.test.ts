import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeEvent } from '../../setup/server'

import cronHandler from '~/server/api/cron/saved-search-alerts.post'
import unsubHandler from '~/server/api/saved-search/unsubscribe.get'
import {
  sendDueSavedSearchAlerts,
  savedSearchUnsubToken,
  verifySavedSearchUnsubToken,
} from '~/server/utils/savedSearchAlerts'
import * as repo from '~/server/repos/savedSearchRepo'
import { listSavedSearchMatchesPage } from '~/server/repos/itemRepo'
import { enqueueEmail } from '~/server/utils/emailQueue'
import { isRecoEnabled } from '~/server/utils/reco'

vi.mock('~/server/repos/savedSearchRepo', () => ({
  listDueAlertSearches: vi.fn(),
  claimAlertSend: vi.fn(),
  setAlertEnabled: vi.fn(),
}))
vi.mock('~/server/repos/itemRepo', () => ({ listSavedSearchMatchesPage: vi.fn() }))
vi.mock('~/server/utils/emailQueue', () => ({ enqueueEmail: vi.fn() }))
vi.mock('~/server/utils/reco', () => ({ isRecoEnabled: vi.fn(() => true) }))

const DUE = { id: 'ss1', userId: 'u1', name: 'BMW', query: { q: 'bmw' }, email: 'u1@x.cz', languageCode: 'en' }
const matches = (n: number) => ({
  // bids:[] so itemCurrentPrice (reads item.bids) works on the card mapping.
  items: Array.from({ length: n }, (_, i) => ({
    id: `i${i}`,
    title: `Car ${i}`,
    image: '',
    endDate: undefined,
    bids: [],
  })),
  total: n,
  page: 1,
  pageSize: 8,
})

const runtime = { internalApiSecret: 'test-secret', cronSecret: 'cron-secret', public: { baseUrl: 'https://app.test' } }
// A valid cron request carries the Bearer secret (the handler uses the real requireCronSecret).
const cronEvent = () => makeEvent({ headers: { authorization: 'Bearer cron-secret' } })

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as Record<string, unknown>).useRuntimeConfig = () => runtime
  vi.mocked(isRecoEnabled).mockReturnValue(true)
  vi.mocked(repo.listDueAlertSearches).mockResolvedValue([DUE] as never)
  vi.mocked(repo.claimAlertSend).mockResolvedValue(true)
  vi.mocked(listSavedSearchMatchesPage).mockResolvedValue(matches(3) as never)
})

describe('sendDueSavedSearchAlerts', () => {
  it('claims then enqueues an alert per due search', async () => {
    const res = await sendDueSavedSearchAlerts({})
    expect(repo.claimAlertSend).toHaveBeenCalledWith('ss1', expect.any(Number))
    expect(enqueueEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient: 'u1@x.cz',
        templateKey: 'savedSearchAlert',
        language: 'en',
        params: expect.objectContaining({ savedSearchName: 'BMW' }),
      }),
      expect.objectContaining({ dedupKey: expect.stringContaining('saved-search:ss1:') }),
    )
    expect(res).toMatchObject({ due: 1, sent: 1, skippedNoItems: 0, errored: 0 })
  })

  // The promise is "due searches WITH new matches": the cron must carry the matched items into the
  // alert payload, not just send an empty shell. Falsifiable — drop the matches and this fails.
  it('carries the matched items into the alert email (the new matches)', async () => {
    await sendDueSavedSearchAlerts({})
    expect(enqueueEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          recommendedItems: expect.arrayContaining([
            expect.objectContaining({ title: 'Car 0' }),
            expect.objectContaining({ title: 'Car 2' }),
          ]),
        }),
      }),
      expect.anything(),
    )
  })

  it('dryRun computes matches but does NOT claim or enqueue', async () => {
    const res = await sendDueSavedSearchAlerts({ dryRun: true })
    expect(repo.claimAlertSend).not.toHaveBeenCalled()
    expect(enqueueEmail).not.toHaveBeenCalled()
    expect(res).toMatchObject({ due: 1, sent: 1 })
  })

  it('skips a search with no matches (skippedNoItems++), no email', async () => {
    vi.mocked(listSavedSearchMatchesPage).mockResolvedValue(matches(0) as never)
    const res = await sendDueSavedSearchAlerts({})
    expect(repo.claimAlertSend).toHaveBeenCalled()
    expect(enqueueEmail).not.toHaveBeenCalled()
    expect(res).toMatchObject({ sent: 0, skippedNoItems: 1 })
  })

  it('skips when the claim is lost (concurrent run)', async () => {
    vi.mocked(repo.claimAlertSend).mockResolvedValue(false)
    const res = await sendDueSavedSearchAlerts({})
    expect(enqueueEmail).not.toHaveBeenCalled()
    expect(res).toMatchObject({ sent: 0 })
  })

  it('counts a per-search failure as errored without aborting the batch', async () => {
    vi.mocked(listSavedSearchMatchesPage).mockRejectedValueOnce(new Error('db down'))
    const res = await sendDueSavedSearchAlerts({})
    expect(res.errored).toBe(1)
  })
})

describe('savedSearchUnsubToken / verify', () => {
  it('round-trips the saved-search id and rejects a tampered token', () => {
    const token = savedSearchUnsubToken('ss1')
    expect(verifySavedSearchUnsubToken(token)).toBe('ss1')
    expect(verifySavedSearchUnsubToken(`ss1.${'0'.repeat(32)}`)).toBeNull()
    expect(verifySavedSearchUnsubToken('garbage')).toBeNull()
  })

  // Owner-scope: a token signs ONE search id, so a real signature minted for search A cannot be
  // re-pointed at search B — verify regenerates B's signature and the mismatch yields null. This is
  // what stops one user's unsubscribe link from disabling another user's alert (no cross-user).
  it('is owner-scoped — a valid signature cannot be re-pointed to another search', () => {
    const ownToken = savedSearchUnsubToken('ssA')
    const sigA = ownToken.slice(ownToken.lastIndexOf('.') + 1)
    expect(verifySavedSearchUnsubToken(ownToken)).toBe('ssA') // owner disables their own alert
    expect(verifySavedSearchUnsubToken(`ssB.${sigA}`)).toBeNull() // …but not anyone else's
  })
})

describe('POST /api/cron/saved-search-alerts', () => {
  it('401s without the cron secret (no Bearer header)', async () => {
    await expect(cronHandler(makeEvent() as never)).rejects.toMatchObject({ statusCode: 401 })
  })

  it('skips when reco is disabled', async () => {
    vi.mocked(isRecoEnabled).mockReturnValue(false)
    const res = await cronHandler(cronEvent() as never)
    expect(res).toEqual({ skipped: 'reco-disabled' })
  })

  it('skips a real run without SendGrid', async () => {
    const prev = process.env.SENDGRID_API_KEY
    delete process.env.SENDGRID_API_KEY
    const res = await cronHandler(cronEvent() as never)
    expect(res).toEqual({ skipped: 'no-sendgrid' })
    if (prev !== undefined) process.env.SENDGRID_API_KEY = prev
  })
})

describe('GET /api/saved-search/unsubscribe', () => {
  it('disables the alert for a valid token and returns confirmation HTML', async () => {
    const token = savedSearchUnsubToken('ss1')
    const html = await unsubHandler(makeEvent({ query: { token } }) as never)
    expect(repo.setAlertEnabled).toHaveBeenCalledWith('ss1', false)
    expect(String(html)).toContain('Alerts off')
  })

  // The link is clicked straight from an alert email — it must disable the alert with no session at
  // all. Asserting the handler never reaches for requireSession locks in "1-click, bez přihlášení"
  // against a future change that bolts auth onto the endpoint. Falsifiable — add a requireSession and
  // this fails.
  it('disables the alert with no login at all (never calls requireSession)', async () => {
    const token = savedSearchUnsubToken('ss1')
    await unsubHandler(makeEvent({ query: { token } }) as never)
    expect(repo.setAlertEnabled).toHaveBeenCalledWith('ss1', false)
    expect((globalThis as Record<string, unknown>).requireSession).not.toHaveBeenCalled()
  })

  it('400s an invalid token without touching the repo', async () => {
    await expect(unsubHandler(makeEvent({ query: { token: 'bad' } }) as never)).rejects.toMatchObject({
      statusCode: 400,
    })
    expect(repo.setAlertEnabled).not.toHaveBeenCalled()
  })

  it('503s when INTERNAL_API_SECRET is unset', async () => {
    ;(globalThis as Record<string, unknown>).useRuntimeConfig = () => ({ public: {} })
    await expect(unsubHandler(makeEvent({ query: { token: 'x' } }) as never)).rejects.toMatchObject({
      statusCode: 503,
    })
  })
})
