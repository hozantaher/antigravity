import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createError } from 'h3'
import { makeEvent } from '../../setup/server'

import newsletterHandler from '~/server/api/cron/newsletter.post'
import { requireCronSecret } from '~/server/utils/session'
import { enforceRateLimit } from '~/server/utils/rateLimit'
import { isRecoEnabled } from '~/server/utils/reco'
import { sendDueNewsletters } from '~/server/utils/newsletterBuilder'

vi.mock('~/server/utils/session', () => ({ requireCronSecret: vi.fn() }))
vi.mock('~/server/utils/rateLimit', () => ({ enforceRateLimit: vi.fn() }))
vi.mock('~/server/utils/reco', () => ({ isRecoEnabled: vi.fn() }))
vi.mock('~/server/utils/newsletterBuilder', () => ({ sendDueNewsletters: vi.fn() }))

const originalSendgrid = process.env.SENDGRID_API_KEY

beforeEach(() => {
  vi.resetAllMocks()
  // Reco enabled by default; individual tests override.
  vi.mocked(isRecoEnabled).mockReturnValue(true)
  process.env.SENDGRID_API_KEY = 'SG.test'
})

afterEach(() => {
  if (originalSendgrid === undefined) delete process.env.SENDGRID_API_KEY
  else process.env.SENDGRID_API_KEY = originalSendgrid
})

describe('POST /api/cron/newsletter', () => {
  it('sends a real batch after the secret + rate-limit checks (no dryRun)', async () => {
    const result = { sent: 3, skipped: 0 }
    vi.mocked(sendDueNewsletters).mockResolvedValue(result as never)

    const event = makeEvent()
    expect(await newsletterHandler(event as never)).toEqual(result)

    expect(requireCronSecret).toHaveBeenCalledWith(event)
    expect(enforceRateLimit).toHaveBeenCalledWith(
      event,
      expect.objectContaining({ bucket: 'cron-newsletter', limit: 6, windowMs: 60_000, key: 'scheduler' }),
    )
    expect(sendDueNewsletters).toHaveBeenCalledWith({ dryRun: false })
  })

  it('runs a dryRun selection (dryRun=1 → dryRun true)', async () => {
    const result = { sent: 0, skipped: 0, dryRun: true }
    vi.mocked(sendDueNewsletters).mockResolvedValue(result as never)

    expect(await newsletterHandler(makeEvent({ query: { dryRun: '1' } }) as never)).toEqual(result)
    expect(sendDueNewsletters).toHaveBeenCalledWith({ dryRun: true })
  })

  it('treats a non-"1" dryRun value as a real send', async () => {
    vi.mocked(sendDueNewsletters).mockResolvedValue({} as never)

    await newsletterHandler(makeEvent({ query: { dryRun: 'true' } }) as never)
    expect(sendDueNewsletters).toHaveBeenCalledWith({ dryRun: false })
  })

  it('skips when reco is disabled — before reading dryRun or SendGrid', async () => {
    vi.mocked(isRecoEnabled).mockReturnValue(false)

    expect(await newsletterHandler(makeEvent() as never)).toEqual({ skipped: 'reco-disabled' })
    expect(sendDueNewsletters).not.toHaveBeenCalled()
    expect(requireCronSecret).toHaveBeenCalled()
    expect(enforceRateLimit).toHaveBeenCalled()
  })

  it('skips a real send when SendGrid is unconfigured', async () => {
    delete process.env.SENDGRID_API_KEY

    expect(await newsletterHandler(makeEvent() as never)).toEqual({ skipped: 'no-sendgrid' })
    expect(sendDueNewsletters).not.toHaveBeenCalled()
  })

  it('still runs a dryRun even when SendGrid is unconfigured', async () => {
    delete process.env.SENDGRID_API_KEY
    const result = { sent: 0, dryRun: true }
    vi.mocked(sendDueNewsletters).mockResolvedValue(result as never)

    expect(await newsletterHandler(makeEvent({ query: { dryRun: '1' } }) as never)).toEqual(result)
    expect(sendDueNewsletters).toHaveBeenCalledWith({ dryRun: true })
  })

  it('propagates a failed secret check without rate-limiting or sending', async () => {
    vi.mocked(requireCronSecret).mockImplementation(() => {
      throw createError({ statusCode: 401 })
    })

    await expect(newsletterHandler(makeEvent() as never)).rejects.toMatchObject({ statusCode: 401 })
    expect(enforceRateLimit).not.toHaveBeenCalled()
    expect(isRecoEnabled).not.toHaveBeenCalled()
    expect(sendDueNewsletters).not.toHaveBeenCalled()
  })

  it('propagates a rate-limit rejection without sending', async () => {
    vi.mocked(enforceRateLimit).mockImplementation(() => {
      throw createError({ statusCode: 429 })
    })

    await expect(newsletterHandler(makeEvent() as never)).rejects.toMatchObject({ statusCode: 429 })
    expect(requireCronSecret).toHaveBeenCalled()
    expect(sendDueNewsletters).not.toHaveBeenCalled()
  })

  it('propagates a sendDueNewsletters rejection', async () => {
    vi.mocked(sendDueNewsletters).mockRejectedValue(new Error('builder failed'))

    await expect(newsletterHandler(makeEvent() as never)).rejects.toThrow('builder failed')
    expect(requireCronSecret).toHaveBeenCalled()
    expect(enforceRateLimit).toHaveBeenCalled()
  })
})
