// Single source of truth for the deposit price — the server resolves amounts
// from here, the client only displays them.
export type DepositCurrency = 'CZK' | 'EUR'

export const DEPOSIT_AMOUNTS: Record<DepositCurrency, number> = {
  CZK: 10000,
  EUR: 500,
}

export const depositAmountFor = (currency: DepositCurrency): number => DEPOSIT_AMOUNTS[currency]

export const DEPOSIT_INVOICE_TYPE = 'deposit'

export const isDepositCurrency = (value: unknown): value is DepositCurrency => value === 'CZK' || value === 'EUR'

export interface DepositBankDetails {
  iban: string
  accountNumber: string
  recipient: string
  vs: string
  amount: number
  currency: DepositCurrency
  spayd: string
  invoiceUrl: string | null
}

export type DepositMethod = 'card' | 'transfer'

export type DepositState = 'none' | 'pending' | 'paid'

export interface DepositStatus {
  state: DepositState
  pending?: DepositBankDetails
  paid?: { amount: number; currency: string }
}
