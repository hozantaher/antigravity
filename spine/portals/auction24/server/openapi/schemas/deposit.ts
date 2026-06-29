import { z } from 'zod'
import { registry } from '../registry'

export const DepositTransferRequestSchema = registry.register(
  'DepositTransferRequest',
  z
    .object({
      currency: z.enum(['CZK', 'EUR']).openapi({ example: 'CZK' }),
    })
    .openapi('DepositTransferRequest'),
)

export const DepositBankDetailsSchema = registry.register(
  'DepositBankDetails',
  z
    .object({
      iban: z.string().openapi({ example: 'CZ8820100000002903525501' }),
      accountNumber: z.string().openapi({ example: '2903525501/2010' }),
      recipient: z.string().openapi({ example: 'East West 24 s.r.o.' }),
      vs: z.string().openapi({ example: '1234567890', description: 'Variable symbol that pairs the payment' }),
      amount: z.number().openapi({ example: 10000 }),
      currency: z.enum(['CZK', 'EUR']),
      spayd: z.string().openapi({ description: 'SPAYD payment string rendered as a QR code' }),
      invoiceUrl: z
        .string()
        .nullable()
        .openapi({ description: 'Fakturoid proforma URL; null when the document is not issued yet' }),
    })
    .openapi('DepositBankDetails'),
)

export const DepositCheckoutRequestSchema = registry.register(
  'DepositCheckoutRequest',
  z
    .object({
      currency: z.enum(['CZK', 'EUR']).openapi({ example: 'CZK' }),
    })
    .openapi('DepositCheckoutRequest'),
)

export const DepositCheckoutResponseSchema = registry.register(
  'DepositCheckoutResponse',
  z
    .object({
      url: z.string().openapi({ description: 'Stripe Checkout URL to redirect the user to' }),
    })
    .openapi('DepositCheckoutResponse'),
)

export const DepositStatusSchema = registry.register(
  'DepositStatus',
  z
    .object({
      state: z.enum(['none', 'pending', 'paid']),
      pending: DepositBankDetailsSchema.optional(),
      paid: z.object({ amount: z.number(), currency: z.string() }).optional(),
    })
    .openapi('DepositStatus'),
)
