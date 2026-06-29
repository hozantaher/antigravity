// Google treats `Disallow:` as a left-anchored prefix match, so `/admin` does NOT cover
// `/de/admin`. Under strategy:prefix_except_default every blocked section also exists under each
// non-default locale prefix, so emit the rule for the bare path and for every prefix.
const DISALLOW = ['/admin', '/api', '/auth', '/profile', '/sign', '/favorites', '/search', '/form-sent']
const PREFIXES = ['en', 'de', 'fr', 'pl', 'nl', 'ru', 'ua', 'hr', 'rs', 'me', 'ar'] // cz is unprefixed

export default defineEventHandler(event => {
  const config = useRuntimeConfig()
  const base = (config.public.baseUrl || getRequestURL(event).origin).replace(/\/+$/, '')

  setResponseHeader(event, 'Content-Type', 'text/plain; charset=utf-8')
  setResponseHeader(event, 'Cache-Control', 'public, max-age=86400')

  const lines = ['User-agent: *', 'Allow: /']
  for (const path of DISALLOW) {
    lines.push(`Disallow: ${path}`)
    for (const p of PREFIXES) lines.push(`Disallow: /${p}${path}`)
  }
  lines.push('', `Sitemap: ${base}/sitemap.xml`)
  return lines.join('\n') + '\n'
})
