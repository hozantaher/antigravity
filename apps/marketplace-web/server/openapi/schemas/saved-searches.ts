import { z } from 'zod'
import { registry } from '../registry'
import { SearchQuerySchema } from './search'

// Zod mirror of models/SavedSearch. The `query` field reuses the existing SearchQuerySchema component
// (the stored query IS a SearchQuery). Docs-only (project uses zod for OpenAPI, not runtime validation).
export const SavedSearchSchema = registry.register(
  'SavedSearch',
  z
    .object({
      id: z.string().openapi({ example: 'ssk3f9a2' }),
      userId: z.string(),
      name: z.string().openapi({ example: 'Diesel SUVs under 300k' }),
      query: SearchQuerySchema,
      alertEnabled: z.boolean().openapi({ description: 'Email alerts on for new matching items.' }),
      createdAt: z.number().openapi({ description: 'Epoch-ms.' }),
      updatedAt: z.number().optional().openapi({ description: 'Epoch-ms; absent until first edit.' }),
    })
    .openapi('SavedSearch'),
)

export const CreateSavedSearchRequestSchema = registry.register(
  'CreateSavedSearchRequest',
  z
    .object({
      name: z.string().openapi({ description: 'Non-empty label (≤ 120 chars).', example: 'Octavia diesel' }),
      query: SearchQuerySchema,
      alertEnabled: z.boolean().optional().openapi({ description: 'Defaults to true.' }),
    })
    .openapi('CreateSavedSearchRequest'),
)

export const UpdateSavedSearchRequestSchema = registry.register(
  'UpdateSavedSearchRequest',
  z
    .object({
      name: z.string().optional().openapi({ description: 'New label (≤ 120 chars).' }),
      alertEnabled: z.boolean().optional().openapi({ description: 'Toggle email alerts.' }),
    })
    .openapi('UpdateSavedSearchRequest'),
)
