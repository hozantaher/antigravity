import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeEvent } from '../../setup/server'

import handler from '~/server/api/deposit/status.get'
import { requireSession } from '~/server/utils/session'
import { getDepositStatus } from '~/server/utils/deposit'

vi.mock('~/server/utils/session', () => ({ requireSession: vi.fn() }))
vi.mock('~/server/utils/rateLimit', () => ({ enforceRateLimit: vi.fn() }))
vi.mock('~/server/utils/deposit', () => ({ getDepositStatus: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireSession).mockResolvedValue({ id: 'u1' } as never)
})

describe('GET /api/deposit/status', () => {
  it('returns the deposit status for the session user', async () => {
    vi.mocked(getDepositStatus).mockResolvedValue({ paid: false } as never)
    expect(await handler(makeEvent() as never)).toEqual({ paid: false })
    expect(getDepositStatus).toHaveBeenCalledWith('u1')
  })
})
