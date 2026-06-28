/**
 * Justice.cz parser — public business registry (Obchodní rejstřík).
 *
 * Scrapes the company detail page and pulls structured signals not covered
 * by ARES baseline:
 *   pravni_forma            — a.s., s.r.o., družstvo, ...
 *   datum_vzniku            — ISO date company founded
 *   zakladni_kapital_kc     — registered capital in CZK (number)
 *   statutari               — array of director names (strings)
 *   pocet_zamestnancu_band  — employee count band when published in závěrka
 *
 * Real Justice.cz response is HTML (no JSON API). Patterns are stable
 * because the layout is server-rendered Java forms that haven't changed
 * in years. If patterns drift we fail closed — return [] rather than
 * lying with stale facts.
 */

const FETCH_TIMEOUT_MS = 10_000
const MAX_HTML_BYTES = 500_000

const JUSTICE_BASE_URL = 'https://or.justice.cz/ias/ui/rejstrik-$firma'

// ── Parsers (deterministic, regex over the rendered HTML) ─────────
// Strategy: strip HTML to plaintext, then run label → value regex over it.
// Works across (a) simple fixture HTML like `<th>Label</th><td>X</td>` and
// (b) the real Justice.cz layout where values live inside nested <div>/<span>
// wrappers. We gate each regex with the literal ":" that appears on data
// pages (search-form labels don't consistently carry it in the plaintext
// layout and false-positive matches of `<option>` text are avoided because
// tag stripping drops `<select>` children onto a separate line).

// Search-results link → detail page URL (picked up from results list).
const RX_DETAIL_LINK = /href=["']([^"']*rejstrik-firma\.vysledky\?subjektId=\d+[^"']*typ=(?:PLATNY|UPLNY)[^"']*)["']/i

// Czech month name → number. Dates on Justice.cz show as "5. dubna 2000".
const CZECH_MONTHS = {
  ledna: 1, února: 2, března: 3, dubna: 4, května: 5, června: 6,
  července: 7, srpna: 8, září: 9, října: 10, listopadu: 11, prosince: 12,
}

function stripTags(html) {
  if (!html) return ''
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseCzechDate(s) {
  if (!s) return null
  // Numeric: "12. 3. 2015"
  const n = s.match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/)
  if (n) {
    const [, d, mo, y] = n
    const iso = `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso
  }
  // Named month: "5. dubna 2000"
  const nm = s.match(/(\d{1,2})\.\s*([a-zA-ZěščřžýáíéúůťďňĚŠČŘŽÝÁÍÉÚŮŤĎŇ]+)\s+(\d{4})/)
  if (nm) {
    const mo = CZECH_MONTHS[nm[2].toLowerCase()]
    if (mo) return `${nm[3]}-${String(mo).padStart(2,'0')}-${String(nm[1]).padStart(2,'0')}`
  }
  return null
}

function parseCzechNumber(s) {
  if (!s) return null
  const cleaned = String(s).replace(/[\s\u00a0]/g, '').replace(/\./g, '').replace(',', '.')
  const n = Number(cleaned)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

export function parsePravniForma(html) {
  const text = stripTags(html)
  if (!text) return null
  const m = text.match(/Právní forma:\s*([A-Za-zÀ-ž][A-Za-zÀ-ž .\-,]{1,80}?)(?=\s{2,}|\s+(?:Datum|Základní|Statutární|Spisová|Předmět|Obchodní|IČO|Sídlo|$))/i)
  return m ? m[1].trim() : null
}

export function parseDatumVzniku(html) {
  const text = stripTags(html)
  if (!text) return null
  // Prefer match immediately after the label; fall back to first date.
  const m = text.match(/Datum vzniku(?: a zápisu)?:?\s*(\d{1,2}\.\s*(?:\d{1,2}\.|[a-zA-ZěščřžýáíéúůťďňĚŠČŘŽÝÁÍÉÚŮŤĎŇ]+)\s*\d{4})/i)
  return m ? parseCzechDate(m[1]) : null
}

export function parseZakladniKapital(html) {
  const text = stripTags(html)
  if (!text) return null
  const m = text.match(/Základní kapitál:?\s*([\d][\d\s.,\u00a0]*)\s*(?:,-)?\s*Kč/i)
  return m ? parseCzechNumber(m[1]) : null
}

export function parseStatutari(html) {
  if (!html) return []
  // Bound to the statutory section in raw HTML so dozorčí rada / prokura /
  // členové dozorčí rady don't leak in. Then strip tags and scan for
  // role-prefixed names. Two signals:
  //   (1) legacy fixture style: "Jméno: Jan Novák"
  //   (2) real Justice.cz:      "předseda správní rady: Ing. JAN NOVÁK, dat. nar. …"
  const block = html.match(/Statutární orgán[\s\S]{0,10000}?(?=<h2|<h3|Právnická osoba|Dozorčí rada|Prokura|Jednání|Další sekce|$)/i)
  if (!block) return []
  const text = stripTags(block[0])
  const names = new Set()
  // Pattern (1): explicit "Jméno:" label.
  for (const m of text.matchAll(/Jméno:\s*([A-ZÀ-Ž][\p{L} .\-']{1,80}?)(?=\s{2,}|\s+(?:Den vzniku|Datum|Adresa|Funkce|Ve funkci|Jméno:|$))/gu)) {
    const n = m[1].trim()
    if (n) names.add(n)
  }
  // Pattern (2): role → name → ", dat. nar." separator.
  const ROLE_PREFIX = '(?:předseda|místopředseda|člen|členka|jednatel|jednatelka|prokurista|prokuristka)(?:\\s+[\\p{L}]+){0,4}\\s*:\\s*'
  const NAME_CAP = '([\\p{Lu}][\\p{L} .\\-\']{2,80}?)'
  const STOP = ',\\s*(?:dat\\. nar\\.|narozen|narozena|nar\\.|born)'
  const rx = new RegExp(`${ROLE_PREFIX}${NAME_CAP}\\s*${STOP}`, 'giu')
  for (const m of text.matchAll(rx)) {
    const n = m[1].trim().replace(/\s+/g, ' ')
    if (n) names.add(n)
  }
  return Array.from(names)
}

/**
 * Given the search-results page HTML, return an absolute detail-page URL
 * (or null if the search returned zero hits). The href is HTML-entity
 * encoded (e.g. `&amp;`) and relative (`./rejstrik-firma.vysledky?...`)
 * — we decode and resolve against the search URL.
 */
export function extractDetailUrl(searchHtml, searchUrl) {
  if (!searchHtml) return null
  const m = searchHtml.match(RX_DETAIL_LINK)
  if (!m) return null
  const raw = m[1].replace(/&amp;/g, '&')
  try { return new URL(raw, searchUrl).toString() }
  catch { return null }
}

function normalizeIco(ico) {
  if (!ico) return null
  const s = String(ico).replace(/\D/g, '')
  if (s.length < 1 || s.length > 8) return null
  return s.padStart(8, '0')
}

/**
 * @param {string} ico
 * @param {object} [deps]  — { fetch, timeoutMs, baseUrl }
 * @returns {Promise<Array<{field:string,value:any}>>}
 */
export async function probeJustice(ico, deps = {}) {
  const fetchFn   = deps.fetch || globalThis.fetch
  const timeoutMs = deps.timeoutMs || FETCH_TIMEOUT_MS
  const baseUrl   = deps.baseUrl   || JUSTICE_BASE_URL
  const safe = normalizeIco(ico)
  if (!safe) throw new Error(`invalid ico: ${ico}`)
  const searchUrl = `${baseUrl}?ico=${safe}`
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  const headers = { 'user-agent': 'Mozilla/5.0 (compatible; outreach-bot/1.0)' }
  let html = ''
  try {
    // Step 1 — search. If the page already contains detail patterns
    // (test fixture or a future direct-URL flow) we're done. Otherwise
    // follow the "Výpis platných" link to the detail page.
    const r1 = await fetchFn(searchUrl, { signal: ctl.signal, redirect: 'follow', headers })
    if (!r1.ok) return [{ field: 'justice_cz_status', value: `http_${r1.status}` }]
    html = await r1.text()
    if (html.length > MAX_HTML_BYTES) html = html.slice(0, MAX_HTML_BYTES)
    const hasDetail = parseDatumVzniku(html) || parseZakladniKapital(html) || /Statutární orgán/i.test(html)
    if (!hasDetail) {
      const detailUrl = extractDetailUrl(html, searchUrl)
      if (detailUrl) {
        const r2 = await fetchFn(detailUrl, { signal: ctl.signal, redirect: 'follow', headers })
        if (!r2.ok) return [{ field: 'justice_cz_status', value: `http_${r2.status}` }]
        html = await r2.text()
        if (html.length > MAX_HTML_BYTES) html = html.slice(0, MAX_HTML_BYTES)
      }
    }
  } catch (e) {
    return [{ field: 'justice_cz_status', value: e.name === 'AbortError' ? 'timeout' : 'unreachable' }]
  } finally {
    clearTimeout(t)
  }
  const facts = []
  const pf = parsePravniForma(html)
  if (pf) facts.push({ field: 'pravni_forma', value: pf })
  const dv = parseDatumVzniku(html)
  if (dv) facts.push({ field: 'datum_vzniku', value: dv })
  const kp = parseZakladniKapital(html)
  if (kp !== null) facts.push({ field: 'zakladni_kapital_kc', value: kp })
  const st = parseStatutari(html)
  if (st.length) facts.push({ field: 'statutari', value: st })
  facts.push({ field: 'justice_cz_status', value: facts.length > 0 ? 'ok' : 'no_match' })
  return facts
}

probeJustice.version = 'justice_v1'
