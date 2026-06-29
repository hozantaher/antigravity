import type Stripe from 'stripe'
import { getStripe, parseDepositCheckoutSession, parseSaleCheckoutSession } from '../../utils/stripe'
import { finalizeDepositSettlement, sendDepositPaidEmail } from '../../utils/deposit'
import { finalizeSaleSettlement, sendSalePaidEmail } from '../../utils/settlement'
import { captureServerError } from '../../utils/observability'
import { claimStripeEvent, processStripeDeposit } from '../../repos/depositRepo'
import { markSaleCompleted, processStripeSale } from '../../repos/settlementRepo'

interface WebhookResult {
  received: true
  processed: boolean
  reason?: string
}

// Sale branch of the shared webhook. Same signature-verify + event-claim rails as deposit; one branch
// added so deposit settlement is provably unaffected (the dispatch keys on metadata.type). A
// successful settle stamps the item completed (CAS, once) then runs the best-effort finalize + email.
const processStripeSaleEvent = async (
  stripeEvent: Stripe.Event,
  session: Stripe.Checkout.Session,
): Promise<WebhookResult> => {
  const parsed = parseSaleCheckoutSession(session)
  if (!parsed.ok) {
    await claimStripeEvent(stripeEvent.id, stripeEvent.type)
    captureServerError(new Error(`stripe webhook sale: ${parsed.reason} (session ${session.id})`), {
      area: 'stripe.webhook.sale',
      tags: { eventId: stripeEvent.id },
    })
    return { received: true, processed: false, reason: parsed.reason }
  }

  const result = await processStripeSale(
    stripeEvent.id,
    stripeEvent.type,
    parsed.data,
    new Date(stripeEvent.created * 1000),
  )

  switch (result.outcome) {
    case 'duplicate':
      return { received: true, processed: false, reason: 'duplicate_event' }
    case 'already_settled':
      return { received: true, processed: false, reason: 'already_settled' }
    case 'unmatched':
      // Real money arrived with nothing to settle (replay across rails / double charge) — refund
      // territory, never a silent accept.
      captureServerError(
        new Error(
          `stripe sale payment unmatched — refund candidate (session ${parsed.data.sessionId}, pi ${parsed.data.paymentIntent ?? '—'})`,
        ),
        { area: 'stripe.webhook.sale', tags: { userId: parsed.data.userId, itemId: parsed.data.itemId } },
      )
      return { received: true, processed: false, reason: 'unmatched_refund_candidate' }
    case 'settled':
      if (result.settled.itemId) await markSaleCompleted(result.settled.itemId, result.settled.paidOn)
      await finalizeSaleSettlement(result.settled)
      await sendSalePaidEmail(result.settled)
      return { received: true, processed: true }
  }
}

const processStripeEvent = async (stripeEvent: Stripe.Event): Promise<WebhookResult> => {
  if (stripeEvent.type !== 'checkout.session.completed') {
    await claimStripeEvent(stripeEvent.id, stripeEvent.type)
    return { received: true, processed: false, reason: 'ignored' }
  }

  const session = stripeEvent.data.object
  // Branch on the session's product type: sale invoices route to the sale settle path, everything else
  // stays on the deposit path (unchanged). One webhook endpoint, dispatched by metadata.type.
  if (session.metadata?.type === 'sale') {
    return await processStripeSaleEvent(stripeEvent, session)
  }

  const parsed = parseDepositCheckoutSession(session)
  if (!parsed.ok) {
    // Terminal answers — claim so redeliveries short-circuit. Foreign products on a
    // shared Stripe account are expected; anything else on a deposit session is an
    // ops signal.
    await claimStripeEvent(stripeEvent.id, stripeEvent.type)
    if (parsed.reason !== 'not_deposit') {
      captureServerError(new Error(`stripe webhook: ${parsed.reason} (session ${session.id})`), {
        area: 'stripe.webhook.deposit',
        tags: { eventId: stripeEvent.id },
      })
    }
    return { received: true, processed: false, reason: parsed.reason }
  }

  // Claim + settle commit atomically: a crash or DB error rolls the claim back, so
  // Stripe's redelivery re-runs the processing instead of finding a stale claim.
  const result = await processStripeDeposit(
    stripeEvent.id,
    stripeEvent.type,
    parsed.data,
    new Date(stripeEvent.created * 1000),
  )

  switch (result.outcome) {
    case 'duplicate':
      return { received: true, processed: false, reason: 'duplicate_event' }
    case 'already_settled':
      return { received: true, processed: false, reason: 'already_settled' }
    case 'unmatched':
      // Real money arrived with nothing to settle (second completed session, or the
      // deposit was already paid another way) — manual refund territory.
      captureServerError(
        new Error(
          `stripe deposit payment unmatched — refund candidate (session ${parsed.data.sessionId}, pi ${parsed.data.paymentIntent ?? '—'})`,
        ),
        { area: 'stripe.webhook.deposit', tags: { userId: parsed.data.userId } },
      )
      return { received: true, processed: false, reason: 'unmatched_refund_candidate' }
    case 'settled':
      await finalizeDepositSettlement(result.settled)
      await sendDepositPaidEmail(result.settled)
      return { received: true, processed: true }
  }
}

// Stripe webhook (checkout.session.completed → deposit settle). Signature-verified
// against the endpoint secret; fail-closed 401 without leaking which check failed.
export default defineEventHandler(async (event): Promise<WebhookResult> => {
  const config = useRuntimeConfig()
  if (!config.stripeWebhookSecret || !config.stripeSecretKey) {
    throw createError({ statusCode: 401, statusMessage: 'Webhook authentication failed' })
  }

  const rawBody = await readRawBody(event)
  if (!rawBody) throw createError({ statusCode: 400, statusMessage: 'Empty webhook body' })

  const signature = getHeader(event, 'stripe-signature')
  if (!signature) throw createError({ statusCode: 401, statusMessage: 'Webhook authentication failed' })

  let stripeEvent: Stripe.Event
  try {
    stripeEvent = getStripe().webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret)
  } catch (err) {
    captureServerError(err, { area: 'stripe.webhook.signature' })
    throw createError({ statusCode: 401, statusMessage: 'Webhook authentication failed' })
  }

  return await processStripeEvent(stripeEvent)
})
