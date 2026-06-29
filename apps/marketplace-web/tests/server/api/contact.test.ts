import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeEvent, setSessionUser } from '../../setup/server'

import handler from '~/server/api/contact.post'
import { createContactMessage, markContactNotified } from '~/server/repos/contactRepo'
import { getById } from '~/server/repos/itemRepo'
import { enqueueEmail } from '~/server/utils/emailQueue'
import { buildContactNotification } from '~/server/email/internal'
import { captureServerError } from '~/server/utils/observability'

vi.mock('~/server/repos/contactRepo', () => ({ createContactMessage: vi.fn(), markContactNotified: vi.fn() }))
vi.mock('~/server/repos/itemRepo', () => ({ getById: vi.fn() }))
vi.mock('~/server/utils/emailQueue', () => ({ enqueueEmail: vi.fn() }))
vi.mock('~/server/email/internal', () => ({ buildContactNotification: vi.fn() }))
vi.mock('~/server/utils/observability', () => ({ captureServerError: vi.fn() }))
vi.mock('~/utils/company', () => ({ COMPANY: { email: '' } }))

beforeEach(() => {
  vi.clearAllMocks()
  setSessionUser(null)
  ;(globalThis as Record<string, unknown>).useRuntimeConfig = () => ({
    contactNotifyEmail: 'ops@x.cz',
    public: { baseUrl: 'https://app.test' },
  })
  vi.mocked(createContactMessage).mockResolvedValue({ id: 'c1', kind: 'contact', email: 'a@b.cz' } as never)
})

describe('POST /api/contact — offer', () => {
  it('saves an anonymous offer on a real item', async () => {
    vi.mocked(getById).mockResolvedValue({ id: 'i1', title: 'BMW' } as never)
    const res = await handler(
      makeEvent({ body: { type: 'offer', itemId: 'i1', price: { amount: 5000, currency: { code: 'CZK' } } } }) as never,
    )
    expect(getById).toHaveBeenCalledWith('i1')
    expect(createContactMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'offer', itemId: 'i1', offerAmount: 5000, offerCurrency: 'CZK' }),
    )
    expect(res).toMatchObject({ ok: true, id: 'c1' })
  })

  it('400s on an incomplete offer', async () => {
    await expect(handler(makeEvent({ body: { type: 'offer', itemId: 'i1' } }) as never)).rejects.toMatchObject({
      statusCode: 400,
    })
  })

  it('404s when the offered item is missing', async () => {
    vi.mocked(getById).mockResolvedValue(undefined as never)
    await expect(
      handler(
        makeEvent({ body: { type: 'offer', itemId: 'x', price: { amount: 1, currency: { code: 'CZK' } } } }) as never,
      ),
    ).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('POST /api/contact — general form', () => {
  it('saves a valid contact message', async () => {
    const res = await handler(makeEvent({ body: { name: 'Jan', email: 'jan@x.cz', message: 'Hi' } }) as never)
    expect(createContactMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'contact', name: 'Jan' }))
    expect(res).toMatchObject({ ok: true })
  })

  it('400s on a missing/invalid email', async () => {
    await expect(handler(makeEvent({ body: { name: 'Jan', email: 'bad' } }) as never)).rejects.toMatchObject({
      statusCode: 400,
    })
  })

  it('400s on a grossly over-length field instead of truncating', async () => {
    await expect(
      handler(makeEvent({ body: { name: 'x'.repeat(201), email: 'jan@x.cz' } }) as never),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('400s on a missing name', async () => {
    await expect(handler(makeEvent({ body: { email: 'jan@x.cz' } }) as never)).rejects.toMatchObject({
      statusCode: 400,
    })
  })

  it('drops blank/non-string optional fields rather than passing them through', async () => {
    await handler(
      makeEvent({
        body: { name: 'Jan', email: 'jan@x.cz', phone: '   ', location: 123, vehicle: '', message: 'Hi' },
      }) as never,
    )
    expect(createContactMessage).toHaveBeenCalledWith(
      expect.objectContaining({ phone: undefined, location: undefined, vehicle: undefined, message: 'Hi' }),
    )
  })
})

describe('POST /api/contact — body parsing', () => {
  it('falls back to an empty body when readBody throws, then 400s', async () => {
    const event = {
      context: {
        params: {},
        query: {},
        headers: {},
        cookies: {},
        get body() {
          throw new Error('malformed json')
        },
        url: 'http://localhost/',
      },
      node: {
        req: { method: 'POST', url: 'http://localhost/', headers: {} },
        res: { statusCode: 200, setHeader() {} },
      },
    }
    await expect(handler(event as never)).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('POST /api/contact — notifyOps', () => {
  it('enqueues the notification and marks it sent on the offer path (with rendered URL + amount)', async () => {
    vi.mocked(getById).mockResolvedValue({ id: 'i1', title: 'BMW' } as never)
    vi.mocked(buildContactNotification).mockResolvedValue({ subject: 's', html: 'h', text: 't' } as never)
    vi.mocked(createContactMessage).mockResolvedValue({
      id: 'c2',
      kind: 'offer',
      email: 'buyer@x.cz',
      offer: { amount: 5000, currency: { code: 'CZK' } },
    } as never)

    const res = await handler(
      makeEvent({ body: { type: 'offer', itemId: 'i1', price: { amount: 5000, currency: { code: 'CZK' } } } }) as never,
    )

    expect(buildContactNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        itemTitle: 'BMW',
        itemUrl: 'https://app.test/item/i1',
        offerAmount: expect.any(String),
      }),
    )
    expect(enqueueEmail).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: 'ops@x.cz', replyTo: 'buyer@x.cz', label: 'contact:offer' }),
      { dedupKey: 'contact:c2' },
    )
    expect(markContactNotified).toHaveBeenCalledWith('c2')
    expect(res).toMatchObject({ ok: true, id: 'c2' })
  })

  it('renders no itemUrl/offerAmount on the general path', async () => {
    vi.mocked(buildContactNotification).mockResolvedValue({ subject: 's', html: 'h', text: 't' } as never)
    await handler(makeEvent({ body: { name: 'Jan', email: 'jan@x.cz', message: 'Hi' } }) as never)
    expect(buildContactNotification).toHaveBeenCalledWith(
      expect.objectContaining({ itemUrl: undefined, offerAmount: undefined }),
    )
    expect(enqueueEmail).toHaveBeenCalled()
  })

  it('returns early without enqueuing when no recipient is configured', async () => {
    // contactNotifyEmail empty + mocked COMPANY.email empty ⇒ `!recipient` early return.
    ;(globalThis as Record<string, unknown>).useRuntimeConfig = () => ({
      contactNotifyEmail: '',
      public: { baseUrl: 'https://app.test' },
    })
    const res = await handler(makeEvent({ body: { name: 'Jan', email: 'jan@x.cz' } }) as never)
    expect(buildContactNotification).not.toHaveBeenCalled()
    expect(enqueueEmail).not.toHaveBeenCalled()
    expect(markContactNotified).not.toHaveBeenCalled()
    expect(res).toMatchObject({ ok: true })
  })

  it('falls back to a configured contactNotifyEmail when present', async () => {
    vi.mocked(buildContactNotification).mockResolvedValue({ subject: 's', html: 'h', text: 't' } as never)
    await handler(makeEvent({ body: { name: 'Jan', email: 'jan@x.cz' } }) as never)
    expect(enqueueEmail).toHaveBeenCalledWith(expect.objectContaining({ recipient: 'ops@x.cz' }), expect.anything())
  })

  it('swallows a notification failure (message is already persisted)', async () => {
    vi.mocked(enqueueEmail).mockRejectedValue(new Error('redis down'))
    const res = await handler(makeEvent({ body: { name: 'Jan', email: 'jan@x.cz' } }) as never)
    expect(captureServerError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ area: 'contact.notify' }),
    )
    expect(markContactNotified).not.toHaveBeenCalled()
    expect(res).toMatchObject({ ok: true })
  })
})
