import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi'
import { registry, API_TAGS } from './registry'
import { registerAllSchemas } from './schemas/index'
import { registerAllPaths } from './paths/index'

// Explicit calls, not bare side-effect imports — the production build tree-shakes
// `import './paths/index'` away, which silently empties the deployed spec.
let registered = false
const ensureRegistered = (): void => {
  if (registered) return
  registerAllSchemas()
  registerAllPaths()
  registered = true
}

export const generateOpenAPIDocument = (serverUrl?: string) => {
  ensureRegistered()
  const generator = new OpenApiGeneratorV31(registry.definitions)
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Auction24 API',
      version: '1.0.0',
      description:
        'REST API for Auction24.cz — vehicle auction & sales marketplace. ' +
        'Item browsing, auction bidding, account/profile, admin item management.',
    },
    // Injected per-request from the docs' own origin (see _openapi.json.get.ts) so the spec
    // never hardcodes localhost or a stale domain. Empty default for any standalone caller.
    servers: serverUrl ? [{ url: serverUrl, description: 'API server' }] : [],
    tags: [...API_TAGS],
    security: [{ bearerAuth: [] }],
  })
}
