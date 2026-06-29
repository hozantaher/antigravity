// Scalar via CDN bundle — @scalar/nuxt has SSR/CJS compatibility issues.
// Public docs; opt out per-environment with DISABLE_API_DOCS=1.
const enabled = process.env.DISABLE_API_DOCS !== '1'

export default defineEventHandler(event => {
  if (!enabled) throw createError({ statusCode: 404, statusMessage: 'Not found' })

  setResponseHeader(event, 'content-type', 'text/html')
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Auction24 API Docs</title>
</head>
<body>
  <script id="api-reference" data-url="/api/_openapi.json"></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`
})
