import { depositAmountFor, isDepositCurrency } from '~/models'
import { requireSession } from '../../utils/session'
import { enforceRateLimit } from '../../utils/rateLimit'
import { ensureOpenDepositInvoice, expireStripeSessions } from '../../utils/deposit'
import { getStripe, isStripeConfigured, toStripeUnit } from '../../utils/stripe'
import { setInvoiceStripeSession } from '../../repos/depositRepo'

// Starts a card deposit payment: reuses/creates the local open invoice (the same
// document the bank-transfer path pays) and redirects to Stripe Checkout. The
// webhook settles the invoice once the session completes.
export default defineEventHandler(async event => {
  const user = await requireSession(event)
  enforceRateLimit(event, { bucket: 'deposit-checkout', limit: 5, windowMs: 60_000, key: user.id })

  // Same gate the FE uses to show the card option (STRIPE_CARD_ENABLED + key) —
  // a direct POST must not bypass a disabled card channel. The webhook stays
  // active regardless, so sessions from before a flag flip still settle.
  if (!useRuntimeConfig().public.stripeEnabled || !isStripeConfigured()) {
    throw createError({ statusCode: 503, statusMessage: 'Card payments not configured' })
  }

  const body = await readBody(event).catch(() => undefined)
  const currency: unknown = body?.currency
  if (!isDepositCurrency(currency)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid currency' })
  }

  const { invoice } = await ensureOpenDepositInvoice(user.id, currency)
  const amount = Number(invoice.priceAmount ?? depositAmountFor(currency))

  const config = useRuntimeConfig()
  const base = config.public.baseUrl || getRequestURL(event).origin

  // Everything under one idempotency key must be byte-identical across retries —
  // Stripe rejects a reused key with different params as idempotency_error instead
  // of replaying the session. Hence expires_at derives from the same hour bucket
  // (lands 1–2 h out; Stripe minimum is 30 min) and the key carries the invoice id
  // (a currency switch creates a new invoice → new key, no param clash).
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
              name: 'Auction24 — vratná kauce',
              description: 'Vratná kauce pro přístup k aukcím.',
            },
            unit_amount: toStripeUnit(amount),
          },
          quantity: 1,
        },
      ],
      metadata: { type: 'deposit', userId: user.id, invoiceId: invoice.id, currency },
      expires_at: (hourBucket + 2) * 3600,
      success_url: `${base}/profile/billing?deposit=success`,
      cancel_url: `${base}/profile/billing?deposit=cancelled`,
    },
    { idempotencyKey: `deposit-${invoice.id}-${hourBucket}` },
  )

  // A superseded session (new hour bucket → new session) would stay payable until
  // its expires_at and its id is about to be overwritten — kill it now.
  if (invoice.stripeSessionId && invoice.stripeSessionId !== checkout.id) {
    await expireStripeSessions([invoice.stripeSessionId])
  }
  const stillOpen = await setInvoiceStripeSession(invoice.id, checkout.id)
  if (stillOpen === false) {
    // The invoice was settled/canceled between our open-read and now (Fio cron or a sibling card
    // session). Don't leave a payable session for a deposit the user already holds.
    await expireStripeSessions([checkout.id]).catch(() => undefined)
    throw createError({
      statusCode: 409,
      statusMessage: 'Deposit already paid',
      data: { code: 'deposit_already_paid' },
    })
  }

  if (!checkout.url) throw createError({ statusCode: 502, statusMessage: 'Stripe session has no URL' })
  return { url: checkout.url }
})
