import { z } from 'zod'
import { registry } from '../registry'
import { errorResponses, json, jsonBody, jsonPage, pageQuery } from '../schemas/common'
import { ItemSchema } from '../schemas/items'
import { UserSchema, InvoiceSchema } from '../schemas/users'
import { DecodeVinRequestSchema, DecodeVinResponseSchema } from '../schemas/vincario'
import { UploadResponseSchema, ContactMessageSchema } from '../schemas/misc'

// All admin endpoints require a Bearer token whose user has the `admin` role.
const ADMIN_NOTE = 'Requires the `admin` role.'

export const registerAdminPaths = () => {
  registry.registerPath({
    method: 'get',
    path: '/api/admin/items',
    tags: ['admin'],
    summary: 'List items for admin (paginated, includes hidden)',
    description: ADMIN_NOTE,
    request: { query: pageQuery.extend({ search: z.string().optional() }) },
    responses: {
      200: jsonPage(ItemSchema, 'Page of items'),
      401: errorResponses[401],
      403: errorResponses[403],
    },
  })

  registry.registerPath({
    method: 'post',
    path: '/api/admin/item',
    tags: ['admin'],
    summary: 'Create an item',
    description: ADMIN_NOTE,
    request: { body: jsonBody(ItemSchema.partial()) },
    responses: {
      200: json(ItemSchema, 'Created item'),
      401: errorResponses[401],
      403: errorResponses[403],
    },
  })

  registry.registerPath({
    method: 'get',
    path: '/api/admin/item/{id}',
    tags: ['admin'],
    summary: 'Get an item for the editor (full bid history, includes hidden)',
    description: `${ADMIN_NOTE} The public /api/item/{id} is slim (last bid only); the editor needs the full history.`,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: json(ItemSchema, 'Full item'),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  })

  registry.registerPath({
    method: 'put',
    path: '/api/admin/item/{id}',
    tags: ['admin'],
    summary: 'Update an item',
    description: ADMIN_NOTE,
    request: {
      params: z.object({ id: z.string() }),
      body: jsonBody(ItemSchema.partial()),
    },
    responses: {
      200: json(ItemSchema, 'Updated item'),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  })

  registry.registerPath({
    method: 'delete',
    path: '/api/admin/item/{id}',
    tags: ['admin'],
    summary: 'Delete an item',
    description: ADMIN_NOTE,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: json(z.object({ ok: z.boolean() }), 'Deleted'),
      401: errorResponses[401],
      403: errorResponses[403],
    },
  })

  registry.registerPath({
    method: 'post',
    path: '/api/admin/items/decode-vin',
    tags: ['admin'],
    summary: 'Decode a VIN via Vincario',
    description: `${ADMIN_NOTE} Rate limited; results are cached durably so repeat VINs are free.`,
    request: { body: jsonBody(DecodeVinRequestSchema) },
    responses: {
      200: json(DecodeVinResponseSchema, 'Decoded vehicle'),
      400: { description: 'Invalid VIN' },
      401: errorResponses[401],
      402: { description: 'Insufficient Vincario credit' },
      403: errorResponses[403],
      429: errorResponses[429],
      502: { description: 'Vincario service error' },
    },
  })

  registry.registerPath({
    method: 'post',
    path: '/api/admin/uploads',
    tags: ['admin'],
    summary: 'Upload an item image to Firebase Storage',
    description: `${ADMIN_NOTE} Stores under public/ads/{itemId}/ and returns a tokenized download URL.`,
    request: {
      body: {
        content: {
          'multipart/form-data': {
            schema: z.object({
              itemId: z.string(),
              file: z.string().openapi({ format: 'binary' }),
            }),
          },
        },
      },
    },
    responses: {
      200: json(UploadResponseSchema, 'Uploaded'),
      400: { description: 'Missing file or itemId' },
      401: errorResponses[401],
      403: errorResponses[403],
      413: { description: 'File too large' },
      415: { description: 'Unsupported content type' },
      429: errorResponses[429],
    },
  })

  registry.registerPath({
    method: 'get',
    path: '/api/admin/users',
    tags: ['admin'],
    summary: 'List users (paginated)',
    description: ADMIN_NOTE,
    request: { query: pageQuery.extend({ search: z.string().optional() }) },
    responses: {
      200: jsonPage(UserSchema, 'Page of users'),
      401: errorResponses[401],
      403: errorResponses[403],
    },
  })

  registry.registerPath({
    method: 'get',
    path: '/api/admin/user/{id}',
    tags: ['admin'],
    summary: 'Get a user by id',
    description: ADMIN_NOTE,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: json(UserSchema, 'User'),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  })

  registry.registerPath({
    method: 'get',
    path: '/api/admin/user/{id}/invoices',
    tags: ['admin'],
    summary: 'List a user’s invoices (paginated)',
    description: ADMIN_NOTE,
    request: { params: z.object({ id: z.string() }), query: pageQuery },
    responses: {
      200: jsonPage(InvoiceSchema, 'Page of invoices'),
      401: errorResponses[401],
      403: errorResponses[403],
    },
  })

  registry.registerPath({
    method: 'get',
    path: '/api/admin/contact-messages',
    tags: ['admin'],
    summary: 'List contact-form submissions and price offers (paginated)',
    description: ADMIN_NOTE,
    request: { query: pageQuery },
    responses: {
      200: jsonPage(ContactMessageSchema, 'Page of contact messages'),
      401: errorResponses[401],
      403: errorResponses[403],
    },
  })
}
