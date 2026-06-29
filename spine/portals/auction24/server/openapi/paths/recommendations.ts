import { z } from 'zod'
import { registry } from '../registry'
import { json, jsonBody } from '../schemas/common'
import { ItemSchema } from '../schemas/items'

const TrackEventSchema = z
  .object({
    id: z.string().openapi({ description: 'Client UUID — idempotency key' }),
    type: z.string().openapi({ example: 'detail_view' }),
    itemId: z.string().nullish(),
    categoryId: z.string().nullish(),
    value: z.number().nullish().openapi({ description: 'Raw magnitude (seconds / count / ms / 0..1)' }),
    surface: z.string().nullish(),
    position: z.number().int().nullish(),
    propensity: z.number().nullish(),
    meta: z.record(z.string(), z.unknown()).nullish(),
    occurredAt: z.number().openapi({ description: 'Epoch ms at enqueue' }),
  })
  .openapi('TrackEvent')

const TrackBatchSchema = z
  .object({ sessionId: z.string().nullish(), events: z.array(TrackEventSchema) })
  .openapi('TrackBatch')

export const registerRecommendationsPaths = (): void => {
  registry.registerPath({
    method: 'get',
    path: '/api/recommendations/item/{id}',
    tags: ['recommendations'],
    summary: 'Recommended items for a detail page ("Podobné inzeráty")',
    description:
      'Hybrid content/popularity recommendations anchored to the given item. Public; personalized by the `a24_vid` cookie and, when present, the bearer user. Never errors — degrades to a popularity/newest fallback chain.',
    request: {
      params: z.object({ id: z.string() }),
      query: z.object({ limit: z.coerce.number().int().min(4).max(24).optional() }),
    },
    responses: { 200: json(z.array(ItemSchema), 'Ranked items (card projection)') },
    security: [],
  })

  registry.registerPath({
    method: 'get',
    path: '/api/recommendations/home',
    tags: ['recommendations'],
    summary: 'Recommended items for the homepage ("Vybráno pro vás")',
    description:
      'Anchor-less hybrid recommendations. Public; personalized by the `a24_vid` cookie and, when present, the bearer user. Never errors — degrades to a popularity/newest fallback chain.',
    request: { query: z.object({ limit: z.coerce.number().int().min(4).max(24).optional() }) },
    responses: { 200: json(z.array(ItemSchema), 'Ranked items (card projection)') },
    security: [],
  })

  registry.registerPath({
    method: 'post',
    path: '/api/track',
    tags: ['recommendations'],
    summary: 'Ingest interaction events (recommendation signals)',
    description:
      'Consent-gated (requires the `a24_vid` cookie), rate-limited, idempotent on the client event id. Returns 204 with no body. Used by the client `useTracking` beacon (fire-and-forget).',
    request: { body: jsonBody(TrackBatchSchema) },
    responses: { 204: { description: 'Accepted (no content)' } },
    security: [],
  })
}
