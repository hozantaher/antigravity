import { COMPANY } from '~/utils/company'
import { formatPrice } from '~/utils'
import { createContactMessage, markContactNotified } from '~/server/repos/contactRepo'
import { getById } from '~/server/repos/itemRepo'
import { enqueueEmail } from '~/server/utils/emailQueue'
import { buildContactNotification } from '~/server/email/internal'
import { captureServerError } from '~/server/utils/observability'
import type { ContactMessage, Item } from '~/models'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Trim, drop empties, and reject grossly over-length values (storage bound / anti-abuse)
// rather than silently truncating — over-limit input throws 400 below.
const text = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  if (!t) return undefined
  if (t.length > max) throw createError({ statusCode: 400, statusMessage: 'Field too long' })
  return t
}

// Best-effort: the message is already persisted, so a notification failure (no recipient,
// Redis/SendGrid down) must never fail the request — it's logged and swallowed.
const notifyOps = async (msg: ContactMessage, item?: Item): Promise<void> => {
  const config = useRuntimeConfig()
  const recipient = config.contactNotifyEmail || COMPANY.email
  if (!recipient) return
  try {
    const rendered = await buildContactNotification({
      kind: msg.kind,
      name: msg.name,
      email: msg.email,
      phone: msg.phone,
      location: msg.location,
      vehicle: msg.vehicle,
      message: msg.message,
      itemTitle: item?.title,
      itemUrl: item ? `${config.public.baseUrl}/item/${item.id}` : undefined,
      offerAmount: msg.offer ? formatPrice(msg.offer) : undefined,
    })
    // Reply-To lets staff answer the customer directly; dedupKey guards a retried request.
    await enqueueEmail(
      { recipient, rendered, replyTo: msg.email, label: `contact:${msg.kind}` },
      { dedupKey: `contact:${msg.id}` },
    )
    await markContactNotified(msg.id)
  } catch (e) {
    captureServerError(e, { area: 'contact.notify', tags: { id: msg.id, kind: msg.kind } })
  }
}

export default defineEventHandler(async event => {
  enforceRateLimit(event, { bucket: 'contact', limit: 10, windowMs: 60_000 })
  const body = await readBody(event).catch(() => ({}))

  // Price offer on a listing. The user is taken from the session, never from the client-sent
  // body.userId — an unauthenticated caller simply gets an anonymous offer.
  if (body?.type === 'offer') {
    const itemId = text(body?.itemId, 64)
    const amount = Number(body?.price?.amount)
    const currency = text(body?.price?.currency?.code, 8)
    if (!itemId || !Number.isFinite(amount) || amount <= 0 || !currency) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid payload' })
    }

    const item = await getById(itemId)
    if (!item) throw createError({ statusCode: 404, statusMessage: 'Item not found' })

    const session = await getSessionUser(event)
    const saved = await createContactMessage({
      kind: 'offer',
      itemId,
      userId: session?.id,
      name: session?.fullName,
      email: session?.email,
      phone: session?.phone,
      offerAmount: amount,
      offerCurrency: currency,
    })
    await notifyOps(saved, item)
    return { ok: true, id: saved.id }
  }

  // General contact form.
  const name = text(body?.name, 200)
  const email = text(body?.email, 320)
  if (!name || !email || !EMAIL_RE.test(email)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid payload' })
  }

  const saved = await createContactMessage({
    kind: 'contact',
    name,
    email,
    phone: text(body?.phone, 64),
    location: text(body?.location, 200),
    vehicle: text(body?.vehicle, 200),
    message: text(body?.message, 5000),
  })
  await notifyOps(saved)
  return { ok: true, id: saved.id }
})
