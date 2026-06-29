import Stripe from 'stripe'
import type { DepositCurrency } from '~/models'
import { isDepositCurrency } from '~/models'

let stripeInstance: Stripe | null = null

export const isStripeConfigured = (): boolean => Boolean(useRuntimeConfig().stripeSecretKey)

export const getStripe = (): Stripe => {
  if (stripeInstance) return stripeInstance
  const config = useRuntimeConfig()
  if (!config.stripeSecretKey) throw new Error('Stripe not configured')
  stripeInstance = new Stripe(config.stripeSecretKey)
  return stripeInstance
}

// Stripe amounts are integer minor units (haléře/centy).
export const toStripeUnit = (amount: number): number => Math.round(amount * 100)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface DepositCheckoutData {
  userId: string
  // null when metadata is missing/malformed — the webhook then falls back to the
  // user's open invoice in the session currency.
  invoiceId: string | null
  currency: DepositCurrency
  // major units (CZK/EUR), uniform with invoice priceAmount
  amount: number
  sessionId: string
  paymentIntent: string | null
}

// Structural subset of Stripe.Checkout.Session so the parser stays pure and
// unit-testable without constructing SDK objects.
export interface DepositCheckoutSessionLike {
  id?: unknown
  payment_status?: unknown
  amount_total?: unknown
  currency?: unknown
  payment_intent?: unknown
  metadata?: Record<string, unknown> | null
}

export type ParsedDepositCheckout = { ok: true; data: DepositCheckoutData } | { ok: false; reason: string }

export const parseDepositCheckoutSession = (session: DepositCheckoutSessionLike): ParsedDepositCheckout => {
  if (session.metadata?.type !== 'deposit') return { ok: false, reason: 'not_deposit' }
  if (session.payment_status !== 'paid') return { ok: false, reason: 'not_paid' }

  const sessionId = typeof session.id === 'string' ? session.id : ''
  if (!sessionId) return { ok: false, reason: 'missing_session_id' }

  // Firebase UID — an opaque non-empty string, deliberately NOT a UUID check.
  const userId = typeof session.metadata?.userId === 'string' ? session.metadata.userId.trim() : ''
  if (!userId) return { ok: false, reason: 'invalid_user_id' }

  const invoiceIdRaw = typeof session.metadata?.invoiceId === 'string' ? session.metadata.invoiceId : ''
  const invoiceId = UUID_RE.test(invoiceIdRaw) ? invoiceIdRaw : null

  const currency = typeof session.currency === 'string' ? session.currency.toUpperCase() : ''
  if (!isDepositCurrency(currency)) return { ok: false, reason: 'invalid_currency' }

  if (typeof session.amount_total !== 'number' || !Number.isFinite(session.amount_total) || session.amount_total <= 0) {
    return { ok: false, reason: 'invalid_amount' }
  }

  const paymentIntent =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : ((session.payment_intent as { id?: string } | null)?.id ?? null)

  return {
    ok: true,
    data: { userId, invoiceId, currency, amount: session.amount_total / 100, sessionId, paymentIntent },
  }
}

export interface SaleCheckoutData {
  userId: string
  // Item id the sale settles (carried in metadata so the webhook can stamp completion).
  itemId: string
  // Required for sales — a sale invoice is item-scoped and must match by its own id, never a fallback.
  invoiceId: string
  // The auction currency — any ISO code (not constrained to CZK/EUR like the deposit).
  currency: string
  // major units, uniform with invoice priceAmount
  amount: number
  sessionId: string
  paymentIntent: string | null
}

export type ParsedSaleCheckout = { ok: true; data: SaleCheckoutData } | { ok: false; reason: string }

// Parses a Stripe Checkout session for a SALE settlement. Pure (structural session subset) so it's
// unit-testable. metadata.type must be 'sale'; userId/itemId/invoiceId must be present (a sale binds
// to a specific invoice — no fallback guessing).
export const parseSaleCheckoutSession = (session: DepositCheckoutSessionLike): ParsedSaleCheckout => {
  if (session.metadata?.type !== 'sale') return { ok: false, reason: 'not_sale' }
  if (session.payment_status !== 'paid') return { ok: false, reason: 'not_paid' }

  const sessionId = typeof session.id === 'string' ? session.id : ''
  if (!sessionId) return { ok: false, reason: 'missing_session_id' }

  const userId = typeof session.metadata?.userId === 'string' ? session.metadata.userId.trim() : ''
  if (!userId) return { ok: false, reason: 'invalid_user_id' }

  const itemId = typeof session.metadata?.itemId === 'string' ? session.metadata.itemId.trim() : ''
  if (!itemId) return { ok: false, reason: 'invalid_item_id' }

  const invoiceIdRaw = typeof session.metadata?.invoiceId === 'string' ? session.metadata.invoiceId : ''
  const invoiceId = UUID_RE.test(invoiceIdRaw) ? invoiceIdRaw : ''
  if (!invoiceId) return { ok: false, reason: 'invalid_invoice_id' }

  const currency = typeof session.currency === 'string' ? session.currency.toUpperCase() : ''
  if (!currency) return { ok: false, reason: 'invalid_currency' }

  if (typeof session.amount_total !== 'number' || !Number.isFinite(session.amount_total) || session.amount_total <= 0) {
    return { ok: false, reason: 'invalid_amount' }
  }

  const paymentIntent =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : ((session.payment_intent as { id?: string } | null)?.id ?? null)

  return {
    ok: true,
    data: { userId, itemId, invoiceId, currency, amount: session.amount_total / 100, sessionId, paymentIntent },
  }
}
