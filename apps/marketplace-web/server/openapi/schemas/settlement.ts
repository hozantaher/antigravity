import { z } from 'zod'
import { registry } from '../registry'

const PriceSchema = z
  .object({
    amount: z.number().openapi({ example: 32000 }),
    currency: z.object({ code: z.string().openapi({ example: 'EUR' }) }).optional(),
  })
  .openapi('SettlementPrice')

export const SettlementBankDetailsSchema = registry.register(
  'SettlementBankDetails',
  z
    .object({
      iban: z.string().openapi({ example: 'CZ8820100000002903525501' }),
      accountNumber: z.string().openapi({ example: '2903525501/2010' }),
      recipient: z.string().openapi({ example: 'East West 24 s.r.o.' }),
      vs: z.string().openapi({ example: '1234567890', description: 'Variable symbol that pairs the payment' }),
      amount: z.number().openapi({ example: 21500 }),
      currency: z.string().openapi({ example: 'EUR' }),
      spayd: z.string().openapi({ description: 'SPAYD payment string rendered as a QR code' }),
      invoiceUrl: z.string().nullable().openapi({ description: 'Fakturoid invoice URL; null until issued' }),
    })
    .openapi('SettlementBankDetails'),
)

export const SettlementSchema = registry.register(
  'Settlement',
  z
    .object({
      itemId: z.string(),
      invoiceId: z.string().nullable().openapi({ description: 'The sale invoice id; null while still due' }),
      finalPrice: PriceSchema,
      depositCredit: PriceSchema.openapi({ description: 'Deposit offset (0 when currencies differ)' }),
      amountDue: PriceSchema.openapi({ description: 'max(0, finalPrice − depositCredit)' }),
      state: z.enum(['due', 'pending', 'paid', 'completed']),
      bank: SettlementBankDetailsSchema.optional(),
    })
    .openapi('Settlement'),
)

export const SaleTransferResponseSchema = registry.register(
  'SaleTransferResponse',
  z
    .object({
      state: z.enum(['transfer', 'completed']).openapi({
        description: "'completed' when the deposit fully covered the price (settled internally)",
      }),
      bank: SettlementBankDetailsSchema.optional(),
      amountDue: PriceSchema,
    })
    .openapi('SaleTransferResponse'),
)

export const SaleCheckoutResponseSchema = registry.register(
  'SaleCheckoutResponse',
  z
    .object({
      url: z.string().openapi({ description: 'Stripe Checkout URL to redirect the winner to' }),
    })
    .openapi('SaleCheckoutResponse'),
)
