import type { DepositCurrency } from '~/models'

// SPAYD format: https://cs.wikipedia.org/wiki/Platba_QR
export interface SpaydInput {
  iban: string
  amount: number
  currency: DepositCurrency
  vs: string
  recipient: string
  message: string
}

// `*` is the field separator and `%` is SPAYD's escape character — both are dropped
// (lossy, like garaaage) from user-supplied strings rather than %XX-encoded, so a
// crafted fullName can't produce an invalid QR. Values are capped to the spec
// limits (MSG ≤ 60, RN ≤ 35) for strict reader compatibility.
const sanitizeIban = (iban: string): string => iban.replace(/\s+/g, '').toUpperCase()
const sanitizeText = (value: string, maxLength: number): string =>
  value.replace(/[*%]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)

export const buildSpayd = (input: SpaydInput): string => {
  const parts = [
    'SPD',
    '1.0',
    `ACC:${sanitizeIban(input.iban)}`,
    `AM:${input.amount.toFixed(2)}`,
    `CC:${input.currency}`,
    `X-VS:${input.vs}`,
    `MSG:${sanitizeText(input.message, 60)}`,
    `RN:${sanitizeText(input.recipient, 35)}`,
  ]
  return parts.join('*')
}
