import { z } from 'zod'
import { registry } from '../registry'
import { errorResponses, json } from '../schemas/common'
import { SaleCheckoutResponseSchema, SaleTransferResponseSchema, SettlementSchema } from '../schemas/settlement'

export const registerSettlementPaths = () => {
  registry.registerPath({
    method: 'get',
    path: '/api/item/{id}/settlement',
    tags: ['items'],
    summary: 'Sale settlement status for the winner',
    description:
      'Winner-only. Returns the settlement state machine for a sold item: due → pending → paid → completed, ' +
      'with the final price, the deposit credit offset, and the amount due. Polled by the settlement wizard.',
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: json(SettlementSchema, 'Settlement status'),
      401: errorResponses[401],
      403: { description: 'Not the auction winner' },
      404: { description: 'Item not found / not a settlement candidate' },
      429: errorResponses[429],
    },
  })

  registry.registerPath({
    method: 'post',
    path: '/api/item/{id}/settlement/transfer',
    tags: ['items'],
    summary: 'Start a bank-transfer sale payment',
    description:
      'Winner-only. Find-or-creates the type=sale invoice for the amount due and returns bank details + the ' +
      'SPAYD QR string. When the deposit fully covers the price (amount due = 0) the sale settles internally ' +
      'and state is "completed". Idempotent.',
    responses: {
      200: json(SaleTransferResponseSchema, 'Payment details or completed'),
      401: errorResponses[401],
      403: { description: 'Not the auction winner' },
      404: { description: 'Item not found' },
      409: { description: 'Sale already paid' },
      429: errorResponses[429],
      503: { description: 'Sale payments not configured for this currency' },
    },
  })

  registry.registerPath({
    method: 'post',
    path: '/api/item/{id}/settlement/checkout',
    tags: ['items'],
    summary: 'Start a card sale payment (Stripe Checkout)',
    description:
      'Winner-only. Reuses/creates the same local sale invoice as the transfer path and returns a Stripe ' +
      'Checkout URL. The shared Stripe webhook settles the invoice once the payment completes.',
    responses: {
      200: json(SaleCheckoutResponseSchema, 'Checkout redirect URL'),
      401: errorResponses[401],
      403: { description: 'Not the auction winner' },
      404: { description: 'Item not found' },
      409: { description: 'Sale already covered by deposit / already paid' },
      429: errorResponses[429],
      503: { description: 'Card payments not configured' },
    },
  })
}
