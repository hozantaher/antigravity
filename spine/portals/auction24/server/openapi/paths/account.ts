import { z } from 'zod'
import { registry } from '../registry'
import { errorResponses, json, jsonBody, jsonPage, pageQuery } from '../schemas/common'
import { UserSchema, InvoiceSchema, RegisterProfileSchema } from '../schemas/users'
import { ItemSchema } from '../schemas/items'
import {
  ContactRequestSchema,
  TranslateRequestSchema,
  TranslateResponseSchema,
  FavoriteToggleRequestSchema,
} from '../schemas/misc'

export const registerAccountPaths = () => {
  registry.registerPath({
    method: 'get',
    path: '/api/me',
    tags: ['account'],
    summary: 'Get the current user',
    description: 'Anonymous-friendly: returns the user for a valid Bearer token, otherwise null.',
    responses: {
      200: json(UserSchema.nullable(), 'Current user or null'),
    },
  })

  registry.registerPath({
    method: 'put',
    path: '/api/me',
    tags: ['account'],
    summary: 'Update the current user’s profile',
    request: { body: jsonBody(RegisterProfileSchema) },
    responses: {
      200: json(UserSchema, 'Updated user'),
      401: errorResponses[401],
      404: errorResponses[404],
    },
  })

  registry.registerPath({
    method: 'delete',
    path: '/api/me',
    tags: ['account'],
    summary: 'Delete the current user’s account',
    responses: {
      200: json(z.object({ ok: z.boolean() }), 'Deleted'),
      401: errorResponses[401],
    },
  })

  registry.registerPath({
    method: 'get',
    path: '/api/invoices',
    tags: ['account'],
    summary: 'List the current user’s invoices (paginated)',
    request: { query: pageQuery },
    responses: {
      200: jsonPage(InvoiceSchema, 'Page of invoices'),
    },
  })

  registry.registerPath({
    method: 'get',
    path: '/api/favorites',
    tags: ['account'],
    summary: 'List the current user’s favorite items (paginated)',
    request: { query: pageQuery },
    responses: {
      200: jsonPage(ItemSchema, 'Page of favorite items'),
    },
  })

  registry.registerPath({
    method: 'post',
    path: '/api/favorites/toggle',
    tags: ['account'],
    summary: 'Add/remove an item from favorites',
    request: { body: jsonBody(FavoriteToggleRequestSchema) },
    responses: {
      200: json(z.object({ favoriteIds: z.array(z.string()) }), 'Updated favorite ids'),
      400: { description: 'Missing item id' },
      401: errorResponses[401],
    },
  })

  registry.registerPath({
    method: 'post',
    path: '/api/contact',
    tags: ['account'],
    summary: 'Submit a contact message or a price offer',
    description:
      'Persists the message and best-effort e-mails the ops inbox. A price offer (type: "offer") ' +
      'attributes the sender from the session, not the body.',
    request: { body: jsonBody(ContactRequestSchema) },
    responses: {
      200: json(z.object({ ok: z.boolean(), id: z.string() }), 'Stored'),
      400: errorResponses[400],
      404: errorResponses[404],
      429: errorResponses[429],
    },
    security: [],
  })

  registry.registerPath({
    method: 'post',
    path: '/api/translate',
    tags: ['account'],
    summary: 'Translate text via DeepL',
    description: 'Requires the `admin` role. Returns the translations in input order.',
    request: { body: jsonBody(TranslateRequestSchema) },
    responses: {
      200: json(TranslateResponseSchema, 'Translated text(s)'),
      401: errorResponses[401],
      403: errorResponses[403],
      429: errorResponses[429],
      503: errorResponses[503],
    },
  })
}
