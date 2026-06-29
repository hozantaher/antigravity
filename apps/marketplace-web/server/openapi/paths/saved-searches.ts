import { z } from 'zod'
import { registry } from '../registry'
import { errorResponses, json, jsonBody, jsonPage, pageQuery } from '../schemas/common'
import {
  SavedSearchSchema,
  CreateSavedSearchRequestSchema,
  UpdateSavedSearchRequestSchema,
} from '../schemas/saved-searches'

// The four user-facing saved-search CRUD endpoints (tag: account). The alert cron and the HMAC
// unsubscribe stay OUT of the spec — machine-to-machine parity with close-auctions / fio / stripe.
export const registerSavedSearchesPaths = () => {
  registry.registerPath({
    method: 'get',
    path: '/api/saved-searches',
    tags: ['account'],
    summary: "List the current user's saved searches (paginated, newest first)",
    request: { query: pageQuery },
    responses: {
      200: jsonPage(SavedSearchSchema, 'Page of saved searches'),
      401: errorResponses[401],
    },
  })

  registry.registerPath({
    method: 'post',
    path: '/api/saved-searches',
    tags: ['account'],
    summary: 'Create a saved search',
    description: 'Validates the name and enforces a per-user cap (max 50). Rate-limited 20/min per user.',
    request: { body: jsonBody(CreateSavedSearchRequestSchema) },
    responses: {
      201: json(SavedSearchSchema, 'Created saved search'),
      401: errorResponses[401],
      409: { description: 'Saved search limit reached' },
      422: { description: 'Invalid name' },
      429: errorResponses[429],
    },
  })

  registry.registerPath({
    method: 'patch',
    path: '/api/saved-searches/{id}',
    tags: ['account'],
    summary: 'Rename a saved search or toggle its alert',
    description: 'Owner-scoped (404 if not the owner). Only name + alertEnabled are mutable.',
    request: { params: z.object({ id: z.string() }), body: jsonBody(UpdateSavedSearchRequestSchema) },
    responses: {
      200: json(SavedSearchSchema, 'Updated saved search'),
      401: errorResponses[401],
      404: { description: 'Saved search not found' },
      429: errorResponses[429],
    },
  })

  registry.registerPath({
    method: 'delete',
    path: '/api/saved-searches/{id}',
    tags: ['account'],
    summary: 'Delete a saved search',
    description: 'Owner-scoped (404 if not the owner).',
    request: { params: z.object({ id: z.string() }) },
    responses: {
      204: { description: 'Deleted' },
      401: errorResponses[401],
      404: { description: 'Saved search not found' },
      429: errorResponses[429],
    },
  })
}
