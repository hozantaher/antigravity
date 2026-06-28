/**
 * VVZ parser — Věstník veřejných zakázek (CZ public-procurement bulletin).
 *
 * Emits tender-history signals for a registered business:
 *   tendr_count            — number of tenders the company appears in (last N years)
 *   tendr_last_date        — ISO date of the most recent tender
 *   tendr_subjects         — array of up to 5 contract-subject strings
 *   tendr_total_value_kc   — summed contract value in CZK when published
 *   vvz_status             — ok | no_match | http_NNN | timeout | unreachable
 *
 * Parsing approach: regex over a server-rendered HTML results page. This
 * worked against the legacy VVZ (vestnikverejnychzakazek.cz) but the current
 * VVZ/NEN at vvz.nipez.cz / nen.nipez.cz is a React SPA backed by JSON APIs,
 * so a live integration requires either:
 *   (a) pointing `deps.searchUrl` at a cached / archive HTML mirror, or
 *   (b) a separate JSON-API adapter that produces the same facts.
 * The regex/summarize logic is kept intact so (a) remains a one-liner when
 * the archive URL is available.
 */

const FETCH_TIMEOUT_MS = 12_000
const MAX_HTML_BYTES = 1_500_000
const DEFAULT_LOOKBACK_YEARS = 3

// Operator can point this at either the legacy VVZ search or NEN search.
const VVZ_SEARCH_URL = 'https://www.vestnikverejnychzakazek.cz/SearchForm/Search'

// Row extractor — each result row wraps a link to the tender detail and a date.
const RX_ROW = /<tr[^>]*class=["'][^"']*(?:resultRow|result-row|rowResult)[^"']*["'][\s\S]*?<\/tr>/gi
const RX_SUBJECT_IN_ROW = /<a[^>]*href=["'][^"']*(?:Detail|detail|contract)[^"']*["'][^>]*>\s*([^<]+?)\s*<\/a>/i
const RX_DATE_IN_ROW = /(\d{1,2}\.\s*\d{1,2}\.\s*\d{4})/
const RX_VALUE_IN_ROW = /([\d][\d\s.,\u00a0]{2,})\s*(?:Kč|CZK)/i
const RX_NO_RESULTS = /(Nebyl[ay]? nalezen[ay]? žádné|No results found|0 výsledků)/i

function parseCzechDate(s) {
  const m = (s || '').match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/)
  if (!m) return null
  const [, d, mo, y] = m
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null
}

function parseCzechNumber(s) {
  if (!s) return null
  const cleaned = String(s).replace(/[\s\u00a0]/g, '').replace(/\./g, '').replace(',', '.')
  const n = Number(cleaned)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

function normalizeIco(ico) {
  if (!ico) return null
  const s = String(ico).replace(/\D/g, '')
  if (s.length < 1 || s.length > 8) return null
  return s.padStart(8, '0')
}

export function parseTenderRows(html) {
  if (!html) return []
  if (RX_NO_RESULTS.test(html)) return []
  const rows = html.match(RX_ROW) || []
  const out = []
  for (const row of rows) {
    const subjM = row.match(RX_SUBJECT_IN_ROW)
    const dateM = row.match(RX_DATE_IN_ROW)
    const valM  = row.match(RX_VALUE_IN_ROW)
    if (!subjM && !dateM) continue
    out.push({
      subject: subjM ? subjM[1].trim() : null,
      date:    dateM ? parseCzechDate(dateM[1]) : null,
      value:   valM  ? parseCzechNumber(valM[1]) : null,
    })
  }
  return out
}

export function summarizeTenders(rows, opts = {}) {
  const lookbackYears = opts.lookbackYears || DEFAULT_LOOKBACK_YEARS
  const now = opts.now ? new Date(opts.now) : new Date()
  const cutoff = new Date(now.getTime() - lookbackYears * 365 * 86400_000)
  const recent = rows.filter(r => {
    if (!r.date) return false
    return new Date(r.date) >= cutoff
  })
  const dates = recent.map(r => r.date).filter(Boolean).sort().reverse()
  const subjects = recent.map(r => r.subject).filter(Boolean).slice(0, 5)
  const totalValue = recent.reduce((a, r) => a + (r.value || 0), 0)
  return {
    tendr_count: recent.length,
    tendr_last_date: dates[0] || null,
    tendr_subjects: subjects,
    tendr_total_value_kc: totalValue > 0 ? totalValue : null,
  }
}

/**
 * @param {string} ico
 * @param {object} [deps]  — { fetch, timeoutMs, searchUrl, lookbackYears, now }
 * @returns {Promise<Array<{field:string,value:any}>>}
 */
export async function probeVvz(ico, deps = {}) {
  const fetchFn    = deps.fetch       || globalThis.fetch
  const timeoutMs  = deps.timeoutMs   || FETCH_TIMEOUT_MS
  const searchUrl  = deps.searchUrl   || VVZ_SEARCH_URL
  const lookback   = deps.lookbackYears || DEFAULT_LOOKBACK_YEARS
  const safe = normalizeIco(ico)
  if (!safe) throw new Error(`invalid ico: ${ico}`)
  const url = `${searchUrl}?ico=${safe}`
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  let html = ''
  try {
    const r = await fetchFn(url, {
      signal: ctl.signal, redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; outreach-bot/1.0)' },
    })
    if (!r.ok) {
      return [{ field: 'vvz_status', value: `http_${r.status}` }]
    }
    html = await r.text()
    if (html.length > MAX_HTML_BYTES) html = html.slice(0, MAX_HTML_BYTES)
  } catch (e) {
    return [{ field: 'vvz_status', value: e.name === 'AbortError' ? 'timeout' : 'unreachable' }]
  } finally {
    clearTimeout(t)
  }
  const rows = parseTenderRows(html)
  if (rows.length === 0) {
    return [
      { field: 'tendr_count', value: 0 },
      { field: 'vvz_status',  value: 'no_match' },
    ]
  }
  const s = summarizeTenders(rows, { lookbackYears: lookback, now: deps.now })
  const facts = [
    { field: 'tendr_count',          value: s.tendr_count },
    { field: 'tendr_last_date',      value: s.tendr_last_date },
    { field: 'tendr_subjects',       value: s.tendr_subjects },
  ]
  if (s.tendr_total_value_kc !== null) {
    facts.push({ field: 'tendr_total_value_kc', value: s.tendr_total_value_kc })
  }
  facts.push({ field: 'vvz_status', value: 'ok' })
  return facts
}

probeVvz.version = 'vvz_v1'
