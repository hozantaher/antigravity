import { OpenAPIRegistry, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi'
import { z } from 'zod'

extendZodWithOpenApi(z)

export const registry = new OpenAPIRegistry()

registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'Firebase ID Token',
  description:
    'Firebase Authentication ID token obtained via the client SDK (sent as `Authorization: Bearer <idToken>`).',
})

export const API_TAGS = [
  { name: 'auth', description: 'Authentication (Firebase ID token exchange, e-mail actions)' },
  { name: 'items', description: 'Public item browsing, detail, bidding, search' },
  { name: 'reference', description: 'Static reference data (categories, countries, currencies, languages)' },
  { name: 'account', description: 'Current user: profile, invoices, favorites, contact, translate' },
  { name: 'admin', description: 'Admin-only: item CRUD, uploads, VIN decode, users (requires admin role)' },
  { name: 'recommendations', description: 'Recommended items (detail rail) + interaction event ingest' },
] as const
