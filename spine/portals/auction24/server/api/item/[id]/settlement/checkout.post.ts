import { requireSession } from '../../../../utils/session'
import { enforceRateLimit } from '../../../../utils/rateLimit'
import { prepareSaleCheckout, expireSaleStripeSessions } from '../../../../utils/settlement'
import { findSettlementCandidate, settlementError, setSaleInvoiceStripeSession } from '../../../../repos/settlementRepo'
import { getStripe, isStripeConfigured, toStripeUnit } from '../../../../utils/stripe'

// Starts a card sale payment: reuses/creates the same local sale invoice the transfer path pays and
// redirects to Stripe Checkout. The webhook settles it once the session completes. Winner-gated.
export default defineEventHandler(async event => {
  const user = await requireSession(event)
  const itemId = getRouterParam(event, 'id')
  if (!itemId) throw createError({ statusCode: 400, statusMessage: 'Missing item id' })
  enforceRateLimit(event, { bucket: 'settlement-checkout', limit: 5, windowMs: 60_000, key: user.id })

  // Same gate the FE uses (STRIPE_CARD_ENABLED + key) — a direct POST must not bypass a disabled card
  // channel. The webhook stays active regardless, so older sessions still settle.
  if (!useRuntimeConfig().public.stripeEnabled || !isStripeConfigured()) {
    throw createError({ statusCode: 503, statusMessage: 'Card payments not configured' })
  }

  const candidate = await findSettlementCandidate(itemId)
  if (!candidate) throw createError({ statusCode: 404, statusMessage: 'Item not found' })

  const gate = settlementError({
    userId: user.id,
    sold: candidate.sold,
    closed: candidate.closed,
    winnerId: candidate.winnerId,
    alreadyCompleted: candidate.settledAt != null || candidate.invoice?.status === 'paid',
  })
  if (gate) throw createError({ statusCode: gate.status, statusMessage: gate.code })

  const { invoice, amountDue, currency } = await prepareSaleCheckout(itemId, user.id)

  const config = useRuntimeConfig()
  const base = config.public.baseUrl || getRequestURL(event).origin

  // Byte-identical params per idempotency key (Stripe rejects a reused key with different params).
  // expires_at and the key both derive from the hour bucket; the key carries the invoice id.
  const hourBucket = Math.floor(Date.now() / 3_600_000)

  const checkout = await getStripe().checkout.sessions.create(
    {
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: user.email,
      line_items: [
        {
          price_data: {
            currency: currency.toLowerCase(),
            product_data: {
              name: 'Auction24 — úhrada vydražené položky',
              description: 'Doplatek vydražené položky po odečtení kauce.',
            },
            unit_amount: toStripeUnit(amountDue),
          },
          quantity: 1,
        },
      ],
      metadata: { type: 'sale', userId: user.id, invoiceId: invoice.id, itemId, currency },
      expires_at: (hourBucket + 2) * 3600,
      success_url: `${base}/item/${itemId}?settlement=success`,
      cancel_url: `${base}/item/${itemId}?settlement=cancelled`,
    },
    { idempotencyKey: `sale-${invoice.id}-${hourBucket}` },
  )

  // A superseded session (new hour bucket) stays payable until its expires_at and its id is about to
  // be overwritten — kill it now.
  if (invoice.stripeSessionId && invoice.stripeSessionId !== checkout.id) {
    await expireSaleStripeSessions([invoice.stripeSessionId])
  }
  await setSaleInvoiceStripeSession(invoice.id, checkout.id)

  if (!checkout.url) throw createError({ statusCode: 502, statusMessage: 'Stripe session has no URL' })
  return { url: checkout.url }
})
