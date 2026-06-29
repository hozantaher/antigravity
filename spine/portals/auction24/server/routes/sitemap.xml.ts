import { SITEMAP_LOCALES, buildSitemapPages, renderLocalePage, escapeXml } from '~/server/utils/sitemap'

// `/sitemap.xml` is a sitemap INDEX that points at one child per locale (`?loc=<code>`). Each
// child carries only its locale's <loc> entries (plus the hreflang cluster), which keeps every
// file far under the 50k-URL / 50 MB sitemap limits and lets the catalog grow per language.
export default defineEventHandler(async event => {
  const config = useRuntimeConfig()
  // Prefer the configured canonical origin; fall back to the request origin so the sitemap is
  // correct even when BASE_URL is unset (local dev / preview).
  const base = (config.public.baseUrl || getRequestURL(event).origin).replace(/\/+$/, '')
  const locale = SITEMAP_LOCALES.find(l => l.code === (getQuery(event).loc as string | undefined))

  setResponseHeader(event, 'Content-Type', 'application/xml; charset=utf-8')
  setResponseHeader(event, 'Cache-Control', 'public, max-age=3600, s-maxage=3600')

  if (locale) {
    const pages = await buildSitemapPages()
    return (
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
      pages.map(p => renderLocalePage(base, locale.code, p)).join('\n') +
      '\n</urlset>\n'
    )
  }

  const today = new Date().toISOString().slice(0, 10)
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    SITEMAP_LOCALES.map(
      l =>
        `  <sitemap>\n    <loc>${escapeXml(`${base}/sitemap.xml?loc=${l.code}`)}</loc>\n    <lastmod>${today}</lastmod>\n  </sitemap>`,
    ).join('\n') +
    '\n</sitemapindex>\n'
  )
})
