import { generateOpenAPIDocument } from '../openapi/spec'

// Public spec backing the Scalar page. Gate both together (see _docs.get.ts) so the JSON can't
// drift from the HTML. Opt out per-environment with DISABLE_API_DOCS=1.
const enabled = process.env.DISABLE_API_DOCS !== '1'

let cachedSpec: ReturnType<typeof generateOpenAPIDocument> | null = null

export default defineEventHandler(event => {
  if (!enabled) throw createError({ statusCode: 404, statusMessage: 'Not found' })
  if (!cachedSpec) cachedSpec = generateOpenAPIDocument()
  // Point Swagger/Scalar "Try it" at the host actually serving these docs — the docs HTML fetches
  // this spec from its own origin — so production shows the real domain (e.g. new.auction24.cz) and
  // never localhost. xForwardedHost/Proto resolve the public host behind the App Hosting proxy.
  const origin = getRequestURL(event, { xForwardedHost: true, xForwardedProto: true }).origin
  return { ...cachedSpec, servers: [{ url: origin, description: 'API server' }] }
})
