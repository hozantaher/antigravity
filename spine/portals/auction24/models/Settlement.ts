import type { Price } from './Price'

// Sale-settlement money type discriminator on the shared `invoices` table. Deposit rows carry
// DEPOSIT_INVOICE_TYPE; a winner's final-price invoice carries this. Single source of truth so a
// typo'd literal can't silently match nothing in the settle CAS.
export const SALE_INVOICE_TYPE = 'sale'

// Wizard-facing projection over (invoice.status × items.settled_at) — derived, never a stored enum
// (same "derive, don't store" rule as ItemStatus). due → pending → paid → completed.
export type SettlementState = 'due' | 'pending' | 'paid' | 'completed'

export const SETTLEMENT_STATE = {
  due: 'due',
  pending: 'pending',
  paid: 'paid',
  completed: 'completed',
} as const

// The winner-facing settlement record the status endpoint returns and the wizard renders.
export interface Settlement {
  itemId: string
  // The sale invoice id once one exists; null while the sale is still `due`.
  invoiceId: string | null
  finalPrice: Price
  // The deposit credit offset against the final price (0 when currencies differ — no cross-currency
  // offset, see computeAmountDue) — always in the auction currency.
  depositCredit: Price
  amountDue: Price
  state: SettlementState
  // Bank-transfer details + SPAYD QR while `pending` (mirrors DepositStatus.pending). Absent when
  // due/paid/completed or amountDue === 0.
  bank?: SettlementBankDetails
}

export interface SettlementBankDetails {
  iban: string
  accountNumber: string
  recipient: string
  vs: string
  amount: number
  currency: string
  spayd: string
  invoiceUrl: string | null
}

// The transfer endpoint's response: bank details to render, or 'completed' when amountDue was 0 and
// the sale settled internally against the deposit credit (no external rail).
export interface IssueSaleTransferResult {
  state: 'transfer' | 'completed'
  bank?: SettlementBankDetails
  amountDue: Price
}

// max(0, finalPrice − depositHeld), and ONLY when the deposit is in the auction currency. A deposit
// in a different currency is NOT converted (a money-correctness boundary): the offset is skipped and
// the winner owes the full price. Integer-cents internally so float drift can't leak a sub-cent.
export const computeAmountDue = (finalPrice: Price, depositHeld: Price | undefined): Price => {
  const currency = finalPrice.currency
  const priceCents = Math.round((finalPrice.amount ?? 0) * 100)

  const sameCurrency =
    !!depositHeld &&
    !!depositHeld.currency &&
    !!currency &&
    depositHeld.currency.code === currency.code &&
    (depositHeld.amount ?? 0) > 0
  const creditCents = sameCurrency ? Math.round((depositHeld!.amount ?? 0) * 100) : 0

  const dueCents = Math.max(0, priceCents - creditCents)
  return {
    currency,
    // Cap the displayed credit at the price (a deposit larger than the price offsets down to 0 due,
    // not below — the residual is not refunded here, v1 out of scope).
    amount: dueCents / 100,
  }
}

// The deposit credit actually applied (what computeAmountDue offset) — capped at the price, 0 when
// currencies differ. Pairs with computeAmountDue so the UI can show finalPrice − credit = due.
export const depositCreditApplied = (finalPrice: Price, depositHeld: Price | undefined): Price => {
  const currency = finalPrice.currency
  const priceCents = Math.round((finalPrice.amount ?? 0) * 100)
  const sameCurrency =
    !!depositHeld &&
    !!depositHeld.currency &&
    !!currency &&
    depositHeld.currency.code === currency.code &&
    (depositHeld.amount ?? 0) > 0
  const creditCents = sameCurrency ? Math.min(priceCents, Math.round((depositHeld!.amount ?? 0) * 100)) : 0
  return { currency, amount: creditCents / 100 }
}

// Derives the wizard state from the underlying invoice status + the durable completion marker.
//   no invoice           → due
//   invoice unpaid       → pending
//   invoice paid, no mark→ paid
//   invoice paid + mark  → completed
// A canceled invoice (sibling-cancel doesn't apply to sales, but a manual cancel could) reverts to
// due so the winner can re-open settlement.
export const settlementStateFrom = (
  invoiceStatus: string | null | undefined,
  hasCompletionMarker: boolean,
): SettlementState => {
  if (!invoiceStatus || invoiceStatus === 'canceled') return SETTLEMENT_STATE.due
  if (invoiceStatus === 'paid') return hasCompletionMarker ? SETTLEMENT_STATE.completed : SETTLEMENT_STATE.paid
  return SETTLEMENT_STATE.pending
}
