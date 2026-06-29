/**
 * Web scrape parser — fetches a company's homepage and extracts:
 *   tech_stack       — array of detected technologies (Wappalyzer-lite)
 *   site_responsive  — has viewport meta + uses CSS media queries
 *   has_https        — boolean, redirect-aware
 *   has_team_page    — found a /tym /team /o-nas /kontakt link
 *   page_lang        — html lang attribute
 *   site_status      — 'live' | 'parked' | 'redirect_offsite' | 'dead'
 *
 * Design: pure JS, deps-injectable for tests. Real fetch in production,
 * mock fetch in unit tests. Strict timeouts so a slow site doesn't tie up
 * the worker.
 */

const FETCH_TIMEOUT_MS = 8000
const MAX_HTML_BYTES = 800_000

/** Pattern-based detection. Conservative: only flag when signal is clear. */
const TECH_PATTERNS = [
  // CMS
  { tech: 'wordpress',   patterns: [/wp-content\//i, /wp-includes\//i, /<meta name="generator" content="WordPress/i] },
  { tech: 'shopify',     patterns: [/cdn\.shopify\.com/i, /Shopify\.theme/i] },
  { tech: 'wix',         patterns: [/wix\.com/i, /<meta name="generator" content="Wix/i] },
  { tech: 'webflow',     patterns: [/webflow\.com/i, /data-wf-page/i] },
  { tech: 'drupal',      patterns: [/drupal-settings/i, /<meta name="generator" content="Drupal/i] },
  { tech: 'joomla',      patterns: [/<meta name="generator" content="Joomla/i] },
  // Frameworks / SPA
  { tech: 'react',       patterns: [/__NEXT_DATA__/i, /react-dom/i, /id="__next"/i] },
  { tech: 'nextjs',      patterns: [/_next\/static/i, /__NEXT_DATA__/i] },
  { tech: 'nuxt',        patterns: [/window\.__NUXT__/i, /_nuxt\//i] },
  { tech: 'vue',         patterns: [/data-v-app/i, /vue\.runtime/i] },
  { tech: 'angular',     patterns: [/ng-version=/i, /<app-root/i] },
  { tech: 'gatsby',      patterns: [/gatsby-/i, /__gatsby/i] },
  // Czech-local CMS / hosting
  { tech: 'shoptet',     patterns: [/shoptet\.cz/i, /shoptetcdn\.com/i] },
  { tech: 'upgates',     patterns: [/upgates\.cz/i] },
  { tech: 'redbit',      patterns: [/redbit\.cz/i] },
  // E-commerce / analytics
  { tech: 'google_analytics', patterns: [/www\.google-analytics\.com\/analytics\.js/i, /gtag\(/i, /G-[A-Z0-9]{8,}/] },
  { tech: 'facebook_pixel',   patterns: [/connect\.facebook\.net.*fbevents/i, /fbq\(/i] },
  { tech: 'hotjar',           patterns: [/static\.hotjar\.com/i] },
  // Hosting fingerprints
  { tech: 'cloudflare',  patterns: [/cdn-cgi\//i, /__cfduid/i] },
  // Misc
  { tech: 'bootstrap',   patterns: [/cdn\.jsdelivr\.net\/npm\/bootstrap/i, /class="container/i] },
  { tech: 'jquery',      patterns: [/jquery[.\-]\d/i, /jquery\.min\.js/i] },
]

function clipHtml(s) {
  if (!s) return ''
  return s.length > MAX_HTML_BYTES ? s.slice(0, MAX_HTML_BYTES) : s
}

export function detectTechStack(html) {
  const found = new Set()
  if (!html) return []
  for (const { tech, patterns } of TECH_PATTERNS) {
    if (patterns.some(p => p.test(html))) found.add(tech)
  }
  return Array.from(found).sort()
}

export function detectResponsive(html) {
  if (!html) return false
  if (!/<meta[^>]+name=["']viewport["']/i.test(html)) return false
  return /@media\s*[^{]*max-width|@media\s*[^{]*min-width/i.test(html)
}

export function detectTeamPage(html, baseUrl) {
  if (!html) return false
  // Look for hrefs hinting at team/about pages
  const m = html.match(/href=["']([^"']*(?:tym|team|about|o-nas|onas|kontakt|kdo-jsme)[^"']*)["']/i)
  return Boolean(m)
}

export function detectLang(html) {
  const m = html?.match(/<html[^>]+lang=["']([a-z]{2,5}(?:-[A-Z]{2})?)["']/i)
  return m ? m[1].toLowerCase() : null
}

/** Heuristic page status. */
export function classifySiteStatus({ html, finalUrl, requestedHost }) {
  if (!html) return 'dead'
  // Parked site fingerprints
  if (/this domain is for sale|domain is parked|sedoparking|godaddy.*parked/i.test(html)) return 'parked'
  if (html.length < 600 && /parking|expired|coming soon/i.test(html)) return 'parked'
  // Off-site redirect
  try {
    if (finalUrl && requestedHost) {
      const finalHost = new URL(finalUrl).hostname.replace(/^www\./, '')
      const reqHost = String(requestedHost).replace(/^www\./, '')
      if (finalHost && reqHost && finalHost !== reqHost && !finalHost.endsWith('.' + reqHost)) {
        return 'redirect_offsite'
      }
    }
  } catch { /* ignore URL parse errors */ }
  return 'live'
}

function normalizeUrl(input) {
  if (!input) return null
  let u = String(input).trim()
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u
  try { return new URL(u).toString() }
  catch { return null }
}

/**
 * @param {string} websiteOrDomain
 * @param {object} [deps]  — { fetch, timeoutMs }
 * @returns {Promise<Array<{field:string,value:any}>>}
 */
export async function probeWeb(websiteOrDomain, deps = {}) {
  const fetchFn   = deps.fetch || globalThis.fetch
  const timeoutMs = deps.timeoutMs || FETCH_TIMEOUT_MS
  const startUrl = normalizeUrl(websiteOrDomain)
  if (!startUrl) throw new Error(`invalid url: ${websiteOrDomain}`)
  const requestedHost = new URL(startUrl).hostname

  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  let html = ''
  let finalUrl = startUrl
  let httpStatus = 0
  let usedHttps = startUrl.startsWith('https://')
  try {
    const r = await fetchFn(startUrl, {
      signal: ctl.signal, redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; outreach-bot/1.0)' },
    })
    httpStatus = r.status
    finalUrl = r.url || startUrl
    usedHttps = finalUrl.startsWith('https://')
    if (r.ok) {
      const reader = r.body?.getReader?.()
      if (reader) {
        const dec = new TextDecoder('utf-8', { fatal: false })
        let total = 0
        const chunks = []
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) {
            total += value.length
            chunks.push(value)
            if (total >= MAX_HTML_BYTES) break
          }
        }
        html = dec.decode(chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0))
      } else {
        html = clipHtml(await r.text())
      }
    }
  } catch (e) {
    return [
      { field: 'site_status', value: e.name === 'AbortError' ? 'timeout' : 'unreachable' },
      { field: 'has_https',   value: usedHttps },
    ]
  } finally {
    clearTimeout(t)
  }

  const tech = detectTechStack(html)
  return [
    { field: 'tech_stack',      value: tech },
    { field: 'site_responsive', value: detectResponsive(html) },
    { field: 'has_https',       value: usedHttps },
    { field: 'has_team_page',   value: detectTeamPage(html, finalUrl) },
    { field: 'page_lang',       value: detectLang(html) },
    { field: 'site_status',     value: classifySiteStatus({ html, finalUrl, requestedHost }) },
    { field: 'http_status',     value: httpStatus },
  ]
}

probeWeb.version = 'web_v1'
