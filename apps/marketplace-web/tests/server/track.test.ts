import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeEvent, setSessionUser } from '../setup/server'
import trackHandler from '~/server/api/track.post'
import { insertEventsBatch } from '~/server/repos/recommendationRepo'

vi.mock('~/server/repos/recommendationRepo', () => ({ insertEventsBatch: vi.fn() }))

const g = globalThis as any
const setReco = (on: boolean) => (g.useRuntimeConfig = () => ({ public: { recoEnabled: on } }))

beforeEach(() => vi.clearAllMocks())

describe('POST /api/track', () => {
  const evt = (over = {}) =>
    makeEvent({ cookies: { a24_vid: 'v1' }, body: { sessionId: 's1', events: [] }, ...over }) as never

  it('204s without writing when the engine is disabled (kill-switch)', async () => {
    setReco(false)
    await trackHandler(evt({ body: { events: [{ id: 'e1', type: 'detail_view', occurredAt: 1 }] } }))
    expect(insertEventsBatch).not.toHaveBeenCalled()
  })

  it('204s without writing when there is no vid cookie (consent gate)', async () => {
    setReco(true)
    await trackHandler(makeEvent({ body: { events: [{ id: 'e1', type: 'detail_view', occurredAt: 1 }] } }) as never)
    expect(insertEventsBatch).not.toHaveBeenCalled()
  })

  it('inserts valid events, drops invalid ones, and attaches vid', async () => {
    setReco(true)
    await trackHandler(
      evt({
        cookies: { a24_vid: 'v1' },
        body: {
          sessionId: 's1',
          events: [
            { id: 'e1', type: 'detail_view', itemId: 'i1', occurredAt: 100 },
            { id: 'e2', type: 'NOPE', occurredAt: 100 }, // unknown type
            { type: 'share', occurredAt: 100 }, // missing id
            { id: 'e3', type: 'photo_view', value: 5, occurredAt: 'oops' }, // bad occurredAt
          ],
        },
      }),
    )
    expect(insertEventsBatch).toHaveBeenCalledTimes(1)
    const rows = vi.mocked(insertEventsBatch).mock.calls[0]![0]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'e1',
      vid: 'v1',
      sessionId: 's1',
      type: 'detail_view',
      itemId: 'i1',
      userId: null,
    })
  })

  it('attaches the session userId when authenticated', async () => {
    setReco(true)
    setSessionUser({ id: 'u42' })
    await trackHandler(evt({ body: { sessionId: 's1', events: [{ id: 'e1', type: 'detail_view', occurredAt: 100 }] } }))
    const rows = vi.mocked(insertEventsBatch).mock.calls[0]![0]
    expect(rows[0]).toMatchObject({ userId: 'u42' })
  })

  it('does not insert when no valid rows survive', async () => {
    setReco(true)
    await trackHandler(evt({ body: { sessionId: 's1', events: [{ id: 'e1', type: 'NOPE', occurredAt: 1 }] } }))
    expect(insertEventsBatch).not.toHaveBeenCalled()
  })

  it('does not insert when the body is null (readBody rejected)', async () => {
    setReco(true)
    // makeEvent with body undefined → readBody resolves undefined; force a rejecting readBody.
    const ev = evt({ body: { sessionId: 's1', events: [] } })
    g.readBody = () => Promise.reject(new Error('boom'))
    await trackHandler(ev)
    expect(insertEventsBatch).not.toHaveBeenCalled()
    g.readBody = (e: any) => Promise.resolve(e?.context?.body)
  })

  it('nulls sessionId when not a string and skips events when not an array', async () => {
    setReco(true)
    await trackHandler(evt({ body: { sessionId: 123, events: 'nope' } }))
    expect(insertEventsBatch).not.toHaveBeenCalled()
  })

  it('truncates an over-long sessionId to 64 chars', async () => {
    setReco(true)
    const longId = 'x'.repeat(200)
    await trackHandler(
      evt({ body: { sessionId: longId, events: [{ id: 'e1', type: 'detail_view', occurredAt: 100 }] } }),
    )
    const rows = vi.mocked(insertEventsBatch).mock.calls[0]![0]
    expect(rows[0]!.sessionId).toHaveLength(64)
  })

  it('caps the event batch at 50 rows', async () => {
    setReco(true)
    const events = Array.from({ length: 80 }, (_, i) => ({ id: `e${i}`, type: 'detail_view', occurredAt: 100 }))
    await trackHandler(evt({ body: { sessionId: 's1', events } }))
    const rows = vi.mocked(insertEventsBatch).mock.calls[0]![0]
    expect(rows).toHaveLength(50)
  })

  it('maps all optional fields when present and well-typed', async () => {
    setReco(true)
    await trackHandler(
      evt({
        body: {
          sessionId: 's1',
          events: [
            {
              id: 'e1',
              type: 'detail_view',
              itemId: 'i1',
              categoryId: 'c1',
              value: 7,
              surface: 'detail',
              position: 3,
              propensity: 0.5,
              meta: { a: 1 },
              occurredAt: 100,
            },
          ],
        },
      }),
    )
    const rows = vi.mocked(insertEventsBatch).mock.calls[0]![0]
    expect(rows[0]).toMatchObject({
      itemId: 'i1',
      categoryId: 'c1',
      value: 7,
      surface: 'detail',
      position: 3,
      propensity: 0.5,
      meta: { a: 1 },
    })
    expect(rows[0]!.occurredAt).toBeInstanceOf(Date)
  })

  it('nulls optional fields when wrong-typed (non-string ids/surface, non-integer position, non-object meta)', async () => {
    setReco(true)
    await trackHandler(
      evt({
        body: {
          sessionId: 's1',
          events: [
            {
              id: 'e1',
              type: 'detail_view',
              itemId: 99,
              categoryId: { x: 1 },
              value: 'nan',
              surface: 5,
              position: 3.5,
              propensity: 'nan',
              meta: 'notobj',
              occurredAt: 100,
            },
          ],
        },
      }),
    )
    const rows = vi.mocked(insertEventsBatch).mock.calls[0]![0]
    expect(rows[0]).toMatchObject({
      itemId: null,
      categoryId: null,
      value: null,
      surface: null,
      position: null,
      propensity: null,
      meta: null,
    })
  })

  it('nulls meta when it is null (falsy short-circuit)', async () => {
    setReco(true)
    await trackHandler(
      evt({ body: { sessionId: 's1', events: [{ id: 'e1', type: 'detail_view', meta: null, occurredAt: 100 }] } }),
    )
    const rows = vi.mocked(insertEventsBatch).mock.calls[0]![0]
    expect(rows[0]!.meta).toBeNull()
  })
})
