import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createError } from 'h3'
import { makeEvent, setSessionUser } from '../../setup/server'

import askHandler from '~/server/api/item/[id]/question.post'
import adminHandler from '~/server/api/admin/item/[id]/question.post'
import { createQuestion, answerQuestion, setQuestionStatus } from '~/server/repos/questionRepo'
import { getById } from '~/server/repos/itemRepo'
import { enqueueEmail } from '~/server/utils/emailQueue'
import { buildContactNotification } from '~/server/email/internal'
import { captureServerError } from '~/server/utils/observability'

vi.mock('~/server/repos/questionRepo', () => ({
  createQuestion: vi.fn(),
  answerQuestion: vi.fn(),
  setQuestionStatus: vi.fn(),
}))
vi.mock('~/server/repos/itemRepo', () => ({ getById: vi.fn() }))
vi.mock('~/server/utils/notify', () => ({ notifyAnswer: vi.fn() }))
vi.mock('~/server/utils/emailQueue', () => ({ enqueueEmail: vi.fn() }))
vi.mock('~/server/email/internal', () => ({ buildContactNotification: vi.fn() }))
vi.mock('~/server/utils/observability', () => ({ captureServerError: vi.fn() }))
vi.mock('~/utils/company', () => ({ COMPANY: { email: '' } }))

const g = globalThis as unknown as { requireAdmin: ReturnType<typeof vi.fn> }

beforeEach(() => {
  vi.clearAllMocks()
  setSessionUser({ id: 'u1', fullName: 'Jan', email: 'jan@x.cz' })
  ;(globalThis as Record<string, unknown>).useRuntimeConfig = () => ({
    contactNotifyEmail: 'ops@x.cz',
    public: { baseUrl: 'https://app.test' },
  })
  vi.mocked(getById).mockResolvedValue({ id: 'itm1', title: 'BMW' } as never)
  vi.mocked(createQuestion).mockResolvedValue({ id: 'q1', itemId: 'itm1', userId: 'u1', body: 'Hi?' } as never)
  vi.mocked(buildContactNotification).mockResolvedValue({ subject: 's', html: 'h', text: 't' } as never)
})

describe('POST /api/item/[id]/question — ask', () => {
  it('creates a question with itemId+userId from the session, not the body', async () => {
    const res = await askHandler(
      makeEvent({ params: { id: 'itm1' }, body: { body: '  Is it real?  ', userId: 'attacker' } }) as never,
    )
    expect(createQuestion).toHaveBeenCalledWith({ itemId: 'itm1', userId: 'u1', body: 'Is it real?' })
    expect(res).toMatchObject({ ok: true, id: 'q1' })
  })

  it('rejects an anonymous user with 401', async () => {
    ;(globalThis as Record<string, unknown>).requireSession = vi
      .fn()
      .mockRejectedValue(createError({ statusCode: 401 }))
    await expect(
      askHandler(makeEvent({ params: { id: 'itm1' }, body: { body: 'Hi?' } }) as never),
    ).rejects.toMatchObject({ statusCode: 401 })
    expect(createQuestion).not.toHaveBeenCalled()
  })

  it('rejects an empty body with 400', async () => {
    await expect(
      askHandler(makeEvent({ params: { id: 'itm1' }, body: { body: '   ' } }) as never),
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(createQuestion).not.toHaveBeenCalled()
  })

  it('rejects an over-length body with 400', async () => {
    await expect(
      askHandler(makeEvent({ params: { id: 'itm1' }, body: { body: 'x'.repeat(2001) } }) as never),
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(createQuestion).not.toHaveBeenCalled()
  })

  it('maps a missing item to 404', async () => {
    vi.mocked(getById).mockResolvedValue(undefined as never)
    await expect(
      askHandler(makeEvent({ params: { id: 'nope' }, body: { body: 'Hi?' } }) as never),
    ).rejects.toMatchObject({ statusCode: 404 })
    expect(createQuestion).not.toHaveBeenCalled()
  })

  it('enqueues a best-effort ops notification and still returns ok if it fails', async () => {
    vi.mocked(enqueueEmail).mockRejectedValue(new Error('redis down'))
    const res = await askHandler(makeEvent({ params: { id: 'itm1' }, body: { body: 'Hi?' } }) as never)
    expect(captureServerError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ area: 'question.notify' }),
    )
    expect(res).toMatchObject({ ok: true })
  })

  // ASK-RATE — the flood guard fires; the request never reaches createQuestion.
  it('propagates the rate-limit rejection and does not persist', async () => {
    ;(globalThis as Record<string, unknown>).enforceRateLimit = vi.fn(() => {
      throw createError({ statusCode: 429, statusMessage: 'Too many requests' })
    })
    await expect(
      askHandler(makeEvent({ params: { id: 'itm1' }, body: { body: 'Flooding?' } }) as never),
    ).rejects.toMatchObject({ statusCode: 429 })
    expect(createQuestion).not.toHaveBeenCalled()
  })

  // ASK-RATE-KEY — the bucket is user-keyed (a signed-in user, not their IP), limit 10 / 60s.
  it('rate-limits the question bucket keyed on the session user id', async () => {
    const spy = vi.fn()
    ;(globalThis as Record<string, unknown>).enforceRateLimit = spy
    await askHandler(makeEvent({ params: { id: 'itm1' }, body: { body: 'Hi?' } }) as never)
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ bucket: 'question', limit: 10, windowMs: 60_000, key: 'u1' }),
    )
  })
})

describe('POST /api/admin/item/[id]/question — answer/moderate', () => {
  beforeEach(() => {
    g.requireAdmin.mockResolvedValue({ id: 'a1' } as never)
  })

  it('answers a question with the admin id from the session, scoped to the route item, and auto-publishes', async () => {
    vi.mocked(answerQuestion).mockResolvedValue({ id: 'q1', status: 'published', answer: 'Yes.' } as never)
    const res = await adminHandler(
      makeEvent({ params: { id: 'itm1' }, body: { questionId: 'q1', answer: ' Yes. ' } }) as never,
    )
    expect(answerQuestion).toHaveBeenCalledWith('q1', 'itm1', 'a1', 'Yes.')
    expect(res).toMatchObject({ id: 'q1', status: 'published' })
  })

  it('changes status without an answer, scoped to the route item', async () => {
    vi.mocked(setQuestionStatus).mockResolvedValue({ id: 'q1', status: 'hidden' } as never)
    const res = await adminHandler(
      makeEvent({ params: { id: 'itm1' }, body: { questionId: 'q1', status: 'hidden' } }) as never,
    )
    expect(setQuestionStatus).toHaveBeenCalledWith('q1', 'itm1', 'hidden')
    expect(res).toMatchObject({ status: 'hidden' })
  })

  it('rejects a non-admin with 403', async () => {
    g.requireAdmin.mockRejectedValue(createError({ statusCode: 403 }))
    await expect(
      adminHandler(makeEvent({ params: { id: 'itm1' }, body: { questionId: 'q1', answer: 'Yes.' } }) as never),
    ).rejects.toMatchObject({ statusCode: 403 })
    expect(answerQuestion).not.toHaveBeenCalled()
  })

  it('400s when neither a non-empty answer nor a valid status is given', async () => {
    await expect(
      adminHandler(makeEvent({ params: { id: 'itm1' }, body: { questionId: 'q1' } }) as never),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('404s when the question is gone', async () => {
    vi.mocked(answerQuestion).mockResolvedValue(undefined as never)
    await expect(
      adminHandler(makeEvent({ params: { id: 'itm1' }, body: { questionId: 'gone', answer: 'Yes.' } }) as never),
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  // ADMIN-1 — missing questionId is a 400 before any repo call.
  it('400s when questionId is missing', async () => {
    await expect(
      adminHandler(makeEvent({ params: { id: 'itm1' }, body: { answer: 'Yes.' } }) as never),
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(answerQuestion).not.toHaveBeenCalled()
    expect(setQuestionStatus).not.toHaveBeenCalled()
  })

  // ADMIN-2 — over-length answer is rejected (storage/abuse bound), never persisted.
  it('400s on an over-length answer and does not call the repo', async () => {
    await expect(
      adminHandler(
        makeEvent({ params: { id: 'itm1' }, body: { questionId: 'q1', answer: 'x'.repeat(5001) } }) as never,
      ),
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(answerQuestion).not.toHaveBeenCalled()
  })

  // ADMIN-3 — a whitespace-only answer is treated as empty → 400 (not a silent publish).
  it('400s on a whitespace-only answer', async () => {
    await expect(
      adminHandler(makeEvent({ params: { id: 'itm1' }, body: { questionId: 'q1', answer: '   ' } }) as never),
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(answerQuestion).not.toHaveBeenCalled()
  })

  // ADMIN-IDOR — a question whose itemId ≠ the route id is not updated by the scoped repo
  // (returns undefined), so the handler 404s: an admin can't moderate across listings.
  it('404s when answering a question that does not belong to the route item (IDOR scope)', async () => {
    vi.mocked(answerQuestion).mockResolvedValue(undefined as never)
    await expect(
      adminHandler(makeEvent({ params: { id: 'other-item' }, body: { questionId: 'q1', answer: 'Yes.' } }) as never),
    ).rejects.toMatchObject({ statusCode: 404 })
    // The route item id is the one passed to the repo (scope is enforced there).
    expect(answerQuestion).toHaveBeenCalledWith('q1', 'other-item', 'a1', 'Yes.')
  })

  // ADMIN-4 — moderating (status path) a vanished / cross-item question is a 404.
  it('404s when changing the status of a question not in the route item', async () => {
    vi.mocked(setQuestionStatus).mockResolvedValue(undefined as never)
    await expect(
      adminHandler(makeEvent({ params: { id: 'itm1' }, body: { questionId: 'gone', status: 'hidden' } }) as never),
    ).rejects.toMatchObject({ statusCode: 404 })
    expect(setQuestionStatus).toHaveBeenCalledWith('gone', 'itm1', 'hidden')
  })
})
