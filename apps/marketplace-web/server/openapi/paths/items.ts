import { z } from 'zod'
import { registry } from '../registry'
import { errorResponses, json, jsonBody, jsonPage, pageQuery } from '../schemas/common'
import { ItemSchema, BidSchema, LiveItemSchema, ITEM_TYPES } from '../schemas/items'
import { PlaceBidRequestSchema } from '../schemas/misc'
import { FUEL_TYPES, TRANSMISSIONS, BODY_TYPES, DRIVE_TYPES, VEHICLE_COLORS } from '~/models'

export const registerItemsPaths = () => {
  registry.registerPath({
    method: 'get',
    path: '/api/items',
    tags: ['items'],
    summary: 'List items (paginated)',
    request: {
      query: pageQuery.extend({
        type: z.enum(ITEM_TYPES).optional(),
        live: z.coerce.boolean().optional().openapi({ description: 'Only currently-live auctions' }),
        categoryId: z.string().optional(),
      }),
    },
    responses: {
      200: jsonPage(ItemSchema, 'Page of items'),
    },
    security: [],
  })

  registry.registerPath({
    method: 'get',
    path: '/api/items/sold',
    tags: ['items'],
    summary: 'List sold items (paginated)',
    request: { query: pageQuery },
    responses: {
      200: jsonPage(ItemSchema, 'Page of sold items'),
    },
    security: [],
  })

  registry.registerPath({
    method: 'get',
    path: '/api/items/live',
    tags: ['items'],
    summary: 'Slim live auction state for one or more items',
    description:
      'Polled by the live layer. Returns current price (last bid), bid count, the (soft-close-extended) end, and close/winner for the given ids. Briefly cached and anonymous.',
    request: {
      query: z.object({
        ids: z.string().openapi({ description: 'Comma-separated item ids (max 50)', example: 'i1,i2,i3' }),
      }),
    },
    responses: {
      200: json(z.array(LiveItemSchema), 'Live state per item (missing ids are omitted)'),
    },
    security: [],
  })

  registry.registerPath({
    method: 'get',
    path: '/api/item/{id}',
    tags: ['items'],
    summary: 'Get item detail',
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: json(ItemSchema, 'Item'),
      404: errorResponses[404],
    },
    security: [],
  })

  registry.registerPath({
    method: 'get',
    path: '/api/item/{id}/bids',
    tags: ['items'],
    summary: 'List an item’s bids (newest first, paginated)',
    request: { params: z.object({ id: z.string() }), query: pageQuery },
    responses: {
      200: jsonPage(BidSchema, 'Page of bids'),
    },
    security: [],
  })

  registry.registerPath({
    method: 'post',
    path: '/api/item/{id}/bid',
    tags: ['items'],
    summary: 'Place a bid on an auction',
    description: 'Requires a verified, deposit-eligible session user. Returns the updated item.',
    request: {
      params: z.object({ id: z.string() }),
      body: jsonBody(PlaceBidRequestSchema),
    },
    responses: {
      200: json(ItemSchema, 'Updated item'),
      400: { description: 'Invalid bid amount' },
      401: errorResponses[401],
      403: { description: 'User not eligible to bid' },
      404: { description: 'Item not found' },
    },
  })

  registry.registerPath({
    method: 'get',
    path: '/api/search',
    tags: ['items'],
    summary: 'Faceted full-text item search (paginated)',
    description:
      'Diacritic-insensitive fulltext (`q`) combined with structured facet filters over the item columns. All facet params are optional and applied as equality (enums) or range (price/year). Response shape is unchanged from the q-only contract. Rate-limited.',
    request: {
      query: pageQuery.extend({
        q: z.string().optional().openapi({ description: 'Diacritic-insensitive fulltext term' }),
        type: z.enum(ITEM_TYPES).optional(),
        categoryId: z.string().optional().openapi({ example: 'cars' }),
        priceMin: z.coerce.number().nonnegative().optional().openapi({ description: 'price_from_amount >=' }),
        priceMax: z.coerce.number().nonnegative().optional().openapi({ description: 'price_from_amount <=' }),
        fuelType: z.enum(FUEL_TYPES).optional(),
        bodyType: z.enum(BODY_TYPES).optional(),
        transmission: z.enum(TRANSMISSIONS).optional(),
        driveType: z.enum(DRIVE_TYPES).optional(),
        color: z.enum(VEHICLE_COLORS).optional(),
        yearFrom: z.coerce.number().int().optional().openapi({ description: 'first_registration_date year >=' }),
        yearTo: z.coerce.number().int().optional().openapi({ description: 'first_registration_date year <=' }),
      }),
    },
    responses: {
      200: jsonPage(ItemSchema, 'Page of matching items'),
      429: errorResponses[429],
    },
    security: [],
  })
}
