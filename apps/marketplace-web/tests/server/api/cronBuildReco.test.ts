import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createError } from 'h3'
import { makeEvent } from '../../setup/server'

import buildRecoHandler from '~/server/api/cron/build-recommendations.post'
import { requireCronSecret } from '~/server/utils/session'
import { enforceRateLimit } from '~/server/utils/rateLimit'
import { buildRecommendations } from '~/server/utils/recommendation/build'

vi.mock('~/server/utils/session', () => ({ requireCronSecret: vi.fn() }))
vi.mock('~/server/utils/rateLimit', () => ({ enforceRateLimit: vi.fn() }))
vi.mock('~/server/utils/recommendation/build', () => ({ buildRecommendations: vi.fn() }))

beforeEach(() => vi.resetAllMocks())

describe('POST /api/cron/build-recommendations', () => {
  it('delegates to buildRecommendations after the secret and rate-limit checks', async () => {
    const result = { items: 16, profiles: 4, heavy: true }
    vi.mocked(buildRecommendations).mockResolvedValue(result as never)

    const event = makeEvent()
    expect(await buildRecoHandler(event as never)).toEqual(result)

    expect(requireCronSecret).toHaveBeenCalledWith(event)
    expect(enforceRateLimit).toHaveBeenCalledWith(
      event,
      expect.objectContaining({ bucket: 'cron-build-recommendations', limit: 6, windowMs: 60_000, key: 'scheduler' }),
    )
    expect(buildRecommendations).toHaveBeenCalledTimes(1)
  })

  it('propagates a failed secret check without rate-limiting or running the job', async () => {
    vi.mocked(requireCronSecret).mockImplementation(() => {
      throw createError({ statusCode: 401 })
    })

    await expect(buildRecoHandler(makeEvent() as never)).rejects.toMatchObject({ statusCode: 401 })
    expect(enforceRateLimit).not.toHaveBeenCalled()
    expect(buildRecommendations).not.toHaveBeenCalled()
  })

  it('propagates a rate-limit rejection without running the job', async () => {
    vi.mocked(enforceRateLimit).mockImplementation(() => {
      throw createError({ statusCode: 429 })
    })

    await expect(buildRecoHandler(makeEvent() as never)).rejects.toMatchObject({ statusCode: 429 })
    expect(requireCronSecret).toHaveBeenCalled()
    expect(buildRecommendations).not.toHaveBeenCalled()
  })

  it('propagates a buildRecommendations rejection', async () => {
    vi.mocked(buildRecommendations).mockRejectedValue(new Error('batch failed'))

    await expect(buildRecoHandler(makeEvent() as never)).rejects.toThrow('batch failed')
    expect(requireCronSecret).toHaveBeenCalled()
    expect(enforceRateLimit).toHaveBeenCalled()
  })
})
