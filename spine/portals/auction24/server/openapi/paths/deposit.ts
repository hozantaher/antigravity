import { registry } from '../registry'
import { errorResponses, json, jsonBody } from '../schemas/common'
import {
  DepositBankDetailsSchema,
  DepositCheckoutRequestSchema,
  DepositCheckoutResponseSchema,
  DepositStatusSchema,
  DepositTransferRequestSchema,
} from '../schemas/deposit'

export const registerDepositPaths = () => {
  registry.registerPath({
    method: 'post',
    path: '/api/deposit/transfer',
    tags: ['account'],
    summary: 'Start a bank-transfer deposit payment',
    description:
      'Issues (or reuses) the unpaid deposit proforma for the chosen currency (10 000 CZK / 500 EUR) and ' +
      'returns the bank details including the SPAYD QR string. The payment is matched later by the Fio cron ' +
      'using the variable symbol.',
    request: { body: jsonBody(DepositTransferRequestSchema) },
    responses: {
      200: json(DepositBankDetailsSchema, 'Payment details'),
      400: errorResponses[400],
      401: errorResponses[401],
      409: { description: 'Deposit already paid' },
      429: errorResponses[429],
      503: { description: 'Deposit payments not configured' },
    },
  })

  registry.registerPath({
    method: 'post',
    path: '/api/deposit/checkout',
    tags: ['account'],
    summary: 'Start a card deposit payment (Stripe Checkout)',
    description:
      'Reuses/creates the open deposit invoice for the chosen currency and returns a Stripe Checkout URL. ' +
      'The Stripe webhook settles the invoice once the payment completes.',
    request: { body: jsonBody(DepositCheckoutRequestSchema) },
    responses: {
      200: json(DepositCheckoutResponseSchema, 'Checkout redirect URL'),
      400: errorResponses[400],
      401: errorResponses[401],
      409: { description: 'Deposit already paid' },
      429: errorResponses[429],
      503: { description: 'Card payments not configured' },
    },
  })

  registry.registerPath({
    method: 'get',
    path: '/api/deposit/status',
    tags: ['account'],
    summary: 'Current deposit state',
    description: 'Polled by the deposit wizard: none → pending (open proforma + bank details) → paid.',
    responses: {
      200: json(DepositStatusSchema, 'Deposit status'),
      401: errorResponses[401],
      429: errorResponses[429],
    },
  })
}
