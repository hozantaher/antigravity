import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeEvent } from '../setup/server'

import sitemapHandler from '~/server/routes/sitemap.xml'
import robotsHandler from '~/server/routes/robots.txt'
import { listSitemapItems } from '~/server/repos/itemRepo'
import { SITEMAP_LOCALES, buildSitemapPages, renderLocalePage, escapeXml, localeUrl } from '~/server/utils/sitemap'

vi.mock('~/server/repos/itemRepo', () => ({ listSitemapItems: vi.fn() }))

// sitemap.ts imports `categories` from `~/server/utils/db`; mock it so the inactive-category skip
// branch in buildSitemapPages is reachable (real fixtures are all active).
vi.mock('~/server/utils/db', () => ({
  categories: [
    { id: 'car', active: true },
    { id: 'hidden', active: false },
    { id: 'moto' }, // active undefined → treated as active (!== false)
  ],
}))

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as Record<string, unknown>).useRuntimeConfig = () => ({ public: { baseUrl: 'https://app.test' } })
})

describe('GET /sitemap.xml (index)', () => {
  it('lists one child sitemap per locale and no page URLs', async () => {
    const xml = (await sitemapHandler(makeEvent() as never)) as string
    expect(xml).toContain('<sitemapindex')
    expect(xml).toContain('<loc>https://app.test/sitemap.xml?loc=cz</loc>')
    expect(xml).toContain('<loc>https://app.test/sitemap.xml?loc=de</loc>')
    expect(xml).toContain('<loc>https://app.test/sitemap.xml?loc=ar</loc>')
    expect(xml).not.toContain('/item/')
  })
})

describe('GET /sitemap.xml?loc=<code> (per-locale child)', () => {
  it('renders that locale URLs with hreflang alternates + x-default', async () => {
    vi.mocked(listSitemapItems).mockResolvedValue([{ id: 'i1', lastmod: new Date('2025-01-01') }] as never)
    const xml = (await sitemapHandler(makeEvent({ query: { loc: 'de' } }) as never)) as string
    expect(xml).toContain('<urlset')
    expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"')
    expect(xml).toContain('<loc>https://app.test/de/item/i1</loc>')
    expect(xml).toContain('<loc>https://app.test/de/auctions</loc>')
    expect(xml).toContain('hreflang="sr-RS"')
    // x-default points at the unprefixed (cz) URL
    expect(xml).toContain('rel="alternate" hreflang="x-default" href="https://app.test/item/i1"')
    // one <url> per page (this locale only), each with 12 locale alternates + x-default = 13
    const itemBlocks = xml.split('<url>').filter(b => b.includes('/item/i1'))
    expect(itemBlocks).toHaveLength(1)
    expect((itemBlocks[0]!.match(/<xhtml:link /g) ?? []).length).toBe(13)
  })

  it('uses unprefixed locs for the default cz child', async () => {
    vi.mocked(listSitemapItems).mockResolvedValue([{ id: 'i1', lastmod: new Date('2025-01-01') }] as never)
    const xml = (await sitemapHandler(makeEvent({ query: { loc: 'cz' } }) as never)) as string
    expect(xml).toContain('<loc>https://app.test/item/i1</loc>')
    expect(xml).toContain('<loc>https://app.test/auctions</loc>')
  })

  it('still serves static URLs when the item query fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(listSitemapItems).mockRejectedValue(new Error('db down'))
    const xml = (await sitemapHandler(makeEvent({ query: { loc: 'de' } }) as never)) as string
    expect(xml).toContain('<urlset')
    expect(xml).toContain('https://app.test/de/auctions')
    expect(xml).not.toContain('/item/')
    spy.mockRestore()
  })
})

describe('GET /robots.txt', () => {
  it('disallows private areas and points to the sitemap', async () => {
    const txt = (await robotsHandler(makeEvent() as never)) as string
    expect(txt).toContain('Disallow: /admin')
    // prefix-match: the bare rule does not cover prefixed locales, so they're emitted too
    expect(txt).toContain('Disallow: /de/admin')
    expect(txt).toContain('Sitemap: https://app.test/sitemap.xml')
  })

  it('falls back to the request origin when baseUrl is unset', async () => {
    ;(globalThis as Record<string, unknown>).useRuntimeConfig = () => ({ public: { baseUrl: '' } })
    const txt = (await robotsHandler(makeEvent({ url: 'https://req.test/foo' }) as never)) as string
    expect(txt).toContain('Sitemap: https://req.test/sitemap.xml')
  })

  it('strips trailing slashes from a configured baseUrl', async () => {
    ;(globalThis as Record<string, unknown>).useRuntimeConfig = () => ({ public: { baseUrl: 'https://app.test///' } })
    const txt = (await robotsHandler(makeEvent() as never)) as string
    expect(txt).toContain('Sitemap: https://app.test/sitemap.xml')
  })
})

describe('sitemap.xml baseUrl fallback', () => {
  it('uses the request origin (trailing slash stripped) when baseUrl is empty', async () => {
    ;(globalThis as Record<string, unknown>).useRuntimeConfig = () => ({ public: { baseUrl: '' } })
    const xml = (await sitemapHandler(makeEvent({ url: 'https://origin.test/' }) as never)) as string
    expect(xml).toContain('<loc>https://origin.test/sitemap.xml?loc=cz</loc>')
  })
})

describe('escapeXml', () => {
  it('escapes all five XML entities including quotes and apostrophes', () => {
    expect(escapeXml(`& < > " '`)).toBe('&amp; &lt; &gt; &quot; &apos;')
  })
})

describe('localeUrl', () => {
  it('omits the prefix for the default cz locale and adds it otherwise', () => {
    expect(localeUrl('https://b.test', 'cz', '/x')).toBe('https://b.test/x')
    expect(localeUrl('https://b.test', 'de', '/x')).toBe('https://b.test/de/x')
  })
})

describe('renderLocalePage', () => {
  it('omits optional lastmod/changefreq/priority lines when absent', () => {
    const xml = renderLocalePage('https://b.test', 'cz', { path: '/bare' })
    expect(xml).toContain('<loc>https://b.test/bare</loc>')
    expect(xml).not.toContain('<lastmod>')
    expect(xml).not.toContain('<changefreq>')
    expect(xml).not.toContain('<priority>')
    // alternate cluster is always present
    expect((xml.match(/<xhtml:link /g) ?? []).length).toBe(SITEMAP_LOCALES.length + 1)
  })

  it('includes all optional lines when present', () => {
    const xml = renderLocalePage('https://b.test', 'cz', {
      path: '/full',
      lastmod: '2025-01-01',
      changefreq: 'daily',
      priority: '0.5',
    })
    expect(xml).toContain('<lastmod>2025-01-01</lastmod>')
    expect(xml).toContain('<changefreq>daily</changefreq>')
    expect(xml).toContain('<priority>0.5</priority>')
  })
})

describe('buildSitemapPages', () => {
  it('skips inactive categories and includes active/undefined ones plus items', async () => {
    vi.mocked(listSitemapItems).mockResolvedValue([{ id: 'x9', lastmod: new Date('2025-02-02') }] as never)
    const pages = await buildSitemapPages()
    const paths = pages.map(p => p.path)
    expect(paths).toContain('/category/car')
    expect(paths).toContain('/category/moto') // active undefined → kept
    expect(paths).not.toContain('/category/hidden') // active === false → skipped
    expect(paths).toContain('/item/x9')
  })

  it('still returns static + category pages when item loading throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(listSitemapItems).mockRejectedValue(new Error('db down'))
    const pages = await buildSitemapPages()
    expect(pages.some(p => p.path === '/')).toBe(true)
    expect(pages.some(p => p.path === '/category/car')).toBe(true)
    expect(pages.some(p => p.path.startsWith('/item/'))).toBe(false)
    spy.mockRestore()
  })
})
