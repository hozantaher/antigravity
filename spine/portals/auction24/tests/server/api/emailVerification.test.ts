import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeEvent } from '../../setup/server'

import handler from '~/server/api/auth/request-email-verification.post'
import { getAuthAdmin, verifyIdToken } from '~/server/utils/firebase'
import { enqueueEmail } from '~/server/utils/emailQueue'
import { failEmailAction } from '~/server/utils/authEmail'

vi.mock('~/server/utils/firebase', () => ({ getAuthAdmin: vi.fn(), verifyIdToken: vi.fn() }))
vi.mock('~/server/utils/emailQueue', () => ({ enqueueEmail: vi.fn() }))
vi.mock('~/server/utils/rateLimit', () => ({ enforceRateLimit: vi.fn() }))
vi.mock('~/server/utils/authEmail', () => ({
  buildOobActionUrl: vi.fn(() => 'https://app/auth/verify?x'),
  failEmailAction: vi.fn(),
}))

const firebaseAuth = { generateEmailVerificationLink: vi.fn() }
const bearer = { headers: { authorization: 'Bearer tok' } }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getAuthAdmin).mockReturnValue(firebaseAuth as never)
})

describe('POST /api/auth/request-email-verification', () => {
  it('401s without an Authorization header', async () => {
    await expect(handler(makeEvent() as never)).rejects.toMatchObject({ statusCode: 401 })
  })

  it('401s on an invalid token', async () => {
    vi.mocked(verifyIdToken).mockRejectedValue(new Error('bad'))
    await expect(handler(makeEvent(bearer) as never)).rejects.toMatchObject({ statusCode: 401 })
  })

  it('400s when the token has no email claim', async () => {
    vi.mocked(verifyIdToken).mockResolvedValue({ uid: 'u1' } as never)
    await expect(handler(makeEvent(bearer) as never)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('short-circuits an already-verified email', async () => {
    vi.mocked(verifyIdToken).mockResolvedValue({ uid: 'u1', email: 'u@x.cz', email_verified: true } as never)
    expect(await handler(makeEvent(bearer) as never)).toEqual({ sent: false })
    expect(enqueueEmail).not.toHaveBeenCalled()
  })

  it('mints a link and enqueues the verification email', async () => {
    vi.mocked(verifyIdToken).mockResolvedValue({ uid: 'u1', email: 'u@x.cz', email_verified: false } as never)
    firebaseAuth.generateEmailVerificationLink.mockResolvedValue('https://firebase/verify?oob=1')
    vi.mocked(enqueueEmail).mockResolvedValue(undefined as never)
    expect(await handler(makeEvent(bearer) as never)).toEqual({ sent: true })
    expect(enqueueEmail).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: 'u@x.cz', templateKey: 'sendVerificationEmail' }),
      { mustDeliver: true },
    )
  })

  it('delegates to failEmailAction when minting the link rejects', async () => {
    vi.mocked(verifyIdToken).mockResolvedValue({ uid: 'u1', email: 'u@x.cz', email_verified: false } as never)
    const boom = new Error('firebase down')
    firebaseAuth.generateEmailVerificationLink.mockRejectedValue(boom)
    vi.mocked(failEmailAction).mockReturnValue({ sent: false } as never)

    expect(await handler(makeEvent(bearer) as never)).toEqual({ sent: false })
    expect(failEmailAction).toHaveBeenCalledWith(
      boom,
      'auth.request-email-verification',
      'Failed to start email verification',
    )
    expect(enqueueEmail).not.toHaveBeenCalled()
  })

  it('delegates to failEmailAction when enqueueing the email rejects', async () => {
    vi.mocked(verifyIdToken).mockResolvedValue({ uid: 'u1', email: 'u@x.cz', email_verified: false } as never)
    firebaseAuth.generateEmailVerificationLink.mockResolvedValue('https://firebase/verify?oob=1')
    const boom = new Error('queue down')
    vi.mocked(enqueueEmail).mockRejectedValue(boom)
    vi.mocked(failEmailAction).mockReturnValue({ sent: false } as never)

    expect(await handler(makeEvent(bearer) as never)).toEqual({ sent: false })
    expect(failEmailAction).toHaveBeenCalledWith(
      boom,
      'auth.request-email-verification.email',
      'Failed to send verification email',
    )
  })
})
