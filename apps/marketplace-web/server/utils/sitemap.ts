import { listSitemapItems } from '~/server/repos/itemRepo'
import { categories } from '~/server/utils/db'

// Mirror of nuxt.config i18n.locales — `code` is the URL prefix, `language` the hreflang tag.
// Keep in sync with nuxt.config.ts. `cz` is the default locale and stays unprefixed.
export const SITEMAP_LOCALES = [
  { code: 'cz', language: 'cs-CZ' },
  { code: 'en', language: 'en-US' },
  { code: 'de', language: 'de-DE' },
  { code: 'fr', language: 'fr-FR' },
  { code: 'pl', language: 'pl-PL' },
  { code: 'nl', language: 'nl-NL' },
  { code: 'ru', language: 'ru-RU' },
  { code: 'ua', language: 'uk-UA' },
  { code: 'hr', language: 'hr-HR' },
  { code: 'rs', language: 'sr-RS' },
  { code: 'me', language: 'sr-ME' },
  { code: 'ar', language: 'ar' },
] as const

export const SITEMAP_DEFAULT_LOCALE = 'cz'

export interface SitemapPage {
  path: string
  lastmod?: string
  changefreq?: string
  priority?: string
}

export const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

const day = (d: Date): string => d.toISOString().slice(0, 10)

// cz → ${base}${path}; other locales → ${base}/${code}${path} (mirrors strategy:prefix_except_default).
export const localeUrl = (base: string, code: string, path: string): string =>
  code === SITEMAP_DEFAULT_LOCALE ? `${base}${path}` : `${base}/${code}${path}`

// hreflang cluster for one logical path: every locale + x-default (→ the cz URL).
const alternates = (base: string, path: string): string =>
  [
    ...SITEMAP_LOCALES.map(
      l =>
        `    <xhtml:link rel="alternate" hreflang="${l.language}" href="${escapeXml(localeUrl(base, l.code, path))}"/>`,
    ),
    `    <xhtml:link rel="alternate" hreflang="x-default" href="${escapeXml(localeUrl(base, SITEMAP_DEFAULT_LOCALE, path))}"/>`,
  ].join('\n')

// A single <url> for (locale, page): the locale's own <loc> plus the shared alternate cluster.
export const renderLocalePage = (base: string, code: string, p: SitemapPage): string => {
  const parts = [`    <loc>${escapeXml(localeUrl(base, code, p.path))}</loc>`]
  if (p.lastmod) parts.push(`    <lastmod>${p.lastmod}</lastmod>`)
  if (p.changefreq) parts.push(`    <changefreq>${p.changefreq}</changefreq>`)
  if (p.priority) parts.push(`    <priority>${p.priority}</priority>`)
  parts.push(alternates(base, p.path))
  return `  <url>\n${parts.join('\n')}\n  </url>`
}

// Locale-independent page list: static + active categories + items. A DB hiccup loading items must
// not 500 the sitemap — the static + category pages still render.
export const buildSitemapPages = async (): Promise<SitemapPage[]> => {
  const today = day(new Date())
  const pages: SitemapPage[] = [
    { path: '/', lastmod: today, changefreq: 'daily', priority: '1.0' },
    { path: '/auctions', lastmod: today, changefreq: 'daily', priority: '0.9' },
    { path: '/buy-now', lastmod: today, changefreq: 'daily', priority: '0.9' },
    { path: '/sold', lastmod: today, changefreq: 'daily', priority: '0.7' },
    { path: '/categories', lastmod: today, changefreq: 'weekly', priority: '0.6' },
    { path: '/about', changefreq: 'monthly', priority: '0.3' },
    { path: '/contact', changefreq: 'monthly', priority: '0.3' },
  ]
  for (const c of categories) {
    if (c.active !== false)
      pages.push({ path: `/category/${c.id}`, lastmod: today, changefreq: 'daily', priority: '0.6' })
  }
  try {
    const items = await listSitemapItems()
    for (const it of items)
      pages.push({ path: `/item/${it.id}`, lastmod: day(it.lastmod), changefreq: 'weekly', priority: '0.8' })
  } catch (e) {
    console.error('[sitemap] failed to load items', e)
  }
  return pages
}
