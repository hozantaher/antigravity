import { describe, it, expect } from 'vitest'
import {
  detectTechStack,
  detectResponsive,
  detectTeamPage,
  detectLang,
  classifySiteStatus,
  probeWeb,
} from '../../../src/lib/webScrape.js'

describe('detectTechStack', () => {
  it('finds wordpress', () => {
    expect(detectTechStack('<link href="/wp-content/themes/x.css">')).toContain('wordpress')
  })
  it('finds nextjs + react', () => {
    const html = '<script id="__NEXT_DATA__">{}</script><link href="/_next/static/chunks/main.js">'
    const t = detectTechStack(html)
    expect(t).toContain('nextjs')
    expect(t).toContain('react')
  })
  it('finds shopify', () => {
    expect(detectTechStack('<script src="//cdn.shopify.com/x.js">')).toContain('shopify')
  })
  it('finds shoptet (Czech)', () => {
    expect(detectTechStack('<link href="//www.shoptet.cz/x.css">')).toContain('shoptet')
  })
  it('returns empty array for plain HTML', () => {
    expect(detectTechStack('<html><body>Hello</body></html>')).toEqual([])
  })
  it('null/empty safe', () => {
    expect(detectTechStack(null)).toEqual([])
    expect(detectTechStack('')).toEqual([])
  })
  it('detects multiple', () => {
    const html = '<link href="/wp-content/x.css"><script>fbq("init")</script>'
    const t = detectTechStack(html)
    expect(t).toContain('wordpress')
    expect(t).toContain('facebook_pixel')
  })
})

describe('detectResponsive', () => {
  it('viewport + media query → true', () => {
    const html = '<meta name="viewport" content="width=device-width"><style>@media (max-width: 600px) {}</style>'
    expect(detectResponsive(html)).toBe(true)
  })
  it('viewport without media queries → false', () => {
    expect(detectResponsive('<meta name="viewport" content="width=device-width">')).toBe(false)
  })
  it('media query without viewport → false', () => {
    expect(detectResponsive('<style>@media (max-width: 600px) {}</style>')).toBe(false)
  })
  it('null safe', () => {
    expect(detectResponsive(null)).toBe(false)
  })
})

describe('detectTeamPage', () => {
  it.each([
    ['<a href="/tym">Tým</a>', true],
    ['<a href="/o-nas">About</a>', true],
    ['<a href="/kontakt">Kontakt</a>', true],
    ['<a href="/team">Team</a>', true],
    ['<a href="/about">About</a>', true],
    ['<a href="/products">Products</a>', false],
  ])('%s → %s', (html, expected) => {
    expect(detectTeamPage(html)).toBe(expected)
  })
})

describe('detectLang', () => {
  it('extracts lang attribute', () => {
    expect(detectLang('<html lang="cs">')).toBe('cs')
    expect(detectLang('<html lang="en-US">')).toBe('en-us')
  })
  it('null when missing', () => {
    expect(detectLang('<html>')).toBe(null)
    expect(detectLang(null)).toBe(null)
  })
})

describe('classifySiteStatus', () => {
  it('parked domain detected', () => {
    expect(classifySiteStatus({ html: 'this domain is for sale', finalUrl: 'https://x.cz', requestedHost: 'x.cz' })).toBe('parked')
  })
  it('off-site redirect detected', () => {
    const r = classifySiteStatus({
      html: '<html>Hi</html>',
      finalUrl: 'https://other.com/',
      requestedHost: 'firma.cz',
    })
    expect(r).toBe('redirect_offsite')
  })
  it('subdomain of requested host is still live', () => {
    const r = classifySiteStatus({
      html: '<html>Hi</html>',
      finalUrl: 'https://www.firma.cz/',
      requestedHost: 'firma.cz',
    })
    expect(r).toBe('live')
  })
  it('empty html → dead', () => {
    expect(classifySiteStatus({ html: '', finalUrl: 'https://x.cz', requestedHost: 'x.cz' })).toBe('dead')
  })
})

describe('probeWeb — orchestration', () => {
  const mockFetch = (response) => async () => ({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    url: response.url ?? 'https://firma.cz/',
    body: null,
    text: async () => response.html ?? '',
  })

  it('emits 7 facts on healthy site', async () => {
    const facts = await probeWeb('firma.cz', {
      fetch: mockFetch({
        html: '<html lang="cs"><head><meta name="viewport" content="width=device-width"><style>@media (max-width: 600px){}</style></head><body><a href="/o-nas">About</a><script src="/wp-content/x.js"></script></body></html>',
        url: 'https://firma.cz/',
      }),
    })
    const byField = Object.fromEntries(facts.map(f => [f.field, f.value]))
    expect(byField.tech_stack).toContain('wordpress')
    expect(byField.site_responsive).toBe(true)
    expect(byField.has_team_page).toBe(true)
    expect(byField.page_lang).toBe('cs')
    expect(byField.site_status).toBe('live')
    expect(byField.http_status).toBe(200)
  })

  it('graceful on fetch error', async () => {
    const facts = await probeWeb('dead.cz', {
      fetch: async () => { throw Object.assign(new Error('refused'), { name: 'TypeError' }) },
    })
    const byField = Object.fromEntries(facts.map(f => [f.field, f.value]))
    expect(byField.site_status).toBe('unreachable')
  })

  it('handles abort/timeout', async () => {
    const facts = await probeWeb('slow.cz', {
      fetch: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) },
    })
    const byField = Object.fromEntries(facts.map(f => [f.field, f.value]))
    expect(byField.site_status).toBe('timeout')
  })

  it('rejects invalid url', async () => {
    await expect(probeWeb('')).rejects.toThrow(/invalid url/)
    await expect(probeWeb(null)).rejects.toThrow(/invalid url/)
  })

  it('reflects parser version', () => {
    expect(probeWeb.version).toBe('web_v1')
  })

  it('off-site redirect classified', async () => {
    const facts = await probeWeb('firma.cz', {
      fetch: mockFetch({ html: '<html>x</html>', url: 'https://other.com/' }),
    })
    const byField = Object.fromEntries(facts.map(f => [f.field, f.value]))
    expect(byField.site_status).toBe('redirect_offsite')
  })
})
