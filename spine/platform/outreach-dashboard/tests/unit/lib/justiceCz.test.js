import { describe, it, expect } from 'vitest'
import {
  parsePravniForma,
  parseDatumVzniku,
  parseZakladniKapital,
  parseStatutari,
  extractDetailUrl,
  probeJustice,
} from '../../../src/lib/justiceCz.js'

const FIXTURE = `
<html><body>
<table>
  <tr>
    <th>Právní forma:</th><td><span>Akciová společnost</span></td>
  </tr>
  <tr>
    <th>Datum vzniku a zápisu:</th><td><span> 12. 3. 2015 </span></td>
  </tr>
  <tr>
    <th>Základní kapitál:</th><td><span> 2 000 000,00 Kč </span></td>
  </tr>
</table>
<h2>Statutární orgán</h2>
<div>
  <div>Jméno: <span>Jan Novák</span></div>
  <div>Jméno: <span>Petra Dvořáková</span></div>
  <div>Jméno: <span>Jan Novák</span></div>
</div>
<h3>Další sekce</h3>
</body></html>
`

describe('parsePravniForma', () => {
  it('extracts from rendered table', () => {
    expect(parsePravniForma(FIXTURE)).toBe('Akciová společnost')
  })
  it('null safe', () => {
    expect(parsePravniForma(null)).toBe(null)
    expect(parsePravniForma('')).toBe(null)
    expect(parsePravniForma('<html>no match</html>')).toBe(null)
  })
})

describe('parseDatumVzniku', () => {
  it('parses Czech date to ISO', () => {
    expect(parseDatumVzniku(FIXTURE)).toBe('2015-03-12')
  })
  it('pads single digits', () => {
    const html = '<th>Datum vzniku a zápisu:</th><td><span>1. 1. 2020</span></td>'
    expect(parseDatumVzniku(html)).toBe('2020-01-01')
  })
  it('parses Czech month names', () => {
    const html = '<div>Datum vzniku a zápisu: <span>5. dubna 2000</span></div>'
    expect(parseDatumVzniku(html)).toBe('2000-04-05')
  })
  it('null on missing', () => {
    expect(parseDatumVzniku('<html></html>')).toBe(null)
    expect(parseDatumVzniku(null)).toBe(null)
  })
})

describe('parseZakladniKapital', () => {
  it('parses Czech-formatted number', () => {
    expect(parseZakladniKapital(FIXTURE)).toBe(2_000_000)
  })
  it('handles plain number', () => {
    const html = '<th>Základní kapitál:</th><td><span>500000 Kč</span></td>'
    expect(parseZakladniKapital(html)).toBe(500_000)
  })
  it('handles nbsp separators', () => {
    const html = '<th>Základní kapitál:</th><td><span>1\u00a0500\u00a0000,00 Kč</span></td>'
    expect(parseZakladniKapital(html)).toBe(1_500_000)
  })
  it('handles multi-span value with ",- Kč" suffix (real Justice.cz layout)', () => {
    const html = '<div class="vr-hlavicka"><span>Základní kapitál: </span></div><div id="udajVypis"><div><span>2 604 000</span><span>,- Kč</span></div></div>'
    expect(parseZakladniKapital(html)).toBe(2_604_000)
  })
  it('null on missing', () => {
    expect(parseZakladniKapital('<html></html>')).toBe(null)
    expect(parseZakladniKapital(null)).toBe(null)
  })
})

describe('parseStatutari', () => {
  it('extracts deduped director names', () => {
    const names = parseStatutari(FIXTURE)
    expect(names).toEqual(['Jan Novák', 'Petra Dvořáková'])
  })
  it('empty when block missing', () => {
    expect(parseStatutari('<html>no orgán here</html>')).toEqual([])
  })
  it('null safe', () => {
    expect(parseStatutari(null)).toEqual([])
    expect(parseStatutari('')).toEqual([])
  })

  it('extracts names via role prefix (real Justice.cz layout)', () => {
    const html = `
      <h2>Statutární orgán - Správní rada</h2>
      <div><span class="nounderline">předseda správní rady: </span></div>
      <div><span>Ing. PAVEL ZIMA</span><span>, dat. nar. </span><span>13. března 1975</span></div>
      <div><span class="nounderline">člen správní rady: </span></div>
      <div><span>MATĚJ HUŠEK</span><span>, nar. </span><span>1. 1. 1980</span></div>
      <h3>Dozorčí rada</h3>
      <div><span>Petra Kontrolová</span></div>
    `
    const names = parseStatutari(html)
    expect(names).toContain('Ing. PAVEL ZIMA')
    expect(names).toContain('MATĚJ HUŠEK')
    // Dozorčí rada must NOT leak into statutari
    expect(names).not.toContain('Petra Kontrolová')
  })
})

describe('probeJustice — orchestration', () => {
  const mockFetch = (response) => async () => ({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    text: async () => response.html ?? '',
  })

  it('emits all facts on full fixture', async () => {
    const facts = await probeJustice('12345678', {
      fetch: mockFetch({ html: FIXTURE }),
    })
    const by = Object.fromEntries(facts.map(f => [f.field, f.value]))
    expect(by.pravni_forma).toBe('Akciová společnost')
    expect(by.datum_vzniku).toBe('2015-03-12')
    expect(by.zakladni_kapital_kc).toBe(2_000_000)
    expect(by.statutari).toEqual(['Jan Novák', 'Petra Dvořáková'])
    expect(by.justice_cz_status).toBe('ok')
  })

  it('pads short ICO to 8 digits in URL', async () => {
    let capturedUrl = ''
    await probeJustice('12345', {
      fetch: async (url) => {
        capturedUrl = url
        return { ok: true, status: 200, text: async () => '' }
      },
    })
    expect(capturedUrl).toContain('ico=00012345')
  })

  it('rejects non-numeric ico', async () => {
    await expect(probeJustice('abc', { fetch: async () => ({}) })).rejects.toThrow(/invalid ico/)
    await expect(probeJustice(null, { fetch: async () => ({}) })).rejects.toThrow(/invalid ico/)
  })

  it('no_match when no patterns hit', async () => {
    const facts = await probeJustice('12345678', {
      fetch: mockFetch({ html: '<html><body>empty page</body></html>' }),
    })
    const by = Object.fromEntries(facts.map(f => [f.field, f.value]))
    expect(by.justice_cz_status).toBe('no_match')
  })

  it('handles http error', async () => {
    const facts = await probeJustice('12345678', {
      fetch: mockFetch({ ok: false, status: 503 }),
    })
    const by = Object.fromEntries(facts.map(f => [f.field, f.value]))
    expect(by.justice_cz_status).toBe('http_503')
  })

  it('handles timeout', async () => {
    const facts = await probeJustice('12345678', {
      fetch: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) },
    })
    const by = Object.fromEntries(facts.map(f => [f.field, f.value]))
    expect(by.justice_cz_status).toBe('timeout')
  })

  it('handles unreachable', async () => {
    const facts = await probeJustice('12345678', {
      fetch: async () => { throw new Error('econnrefused') },
    })
    const by = Object.fromEntries(facts.map(f => [f.field, f.value]))
    expect(by.justice_cz_status).toBe('unreachable')
  })

  it('reflects parser version', () => {
    expect(probeJustice.version).toBe('justice_v1')
  })

  it('rejects search-form dropdown as pravni_forma (false-positive guard)', () => {
    const searchForm = `
      <label class="wide" for="id6">Právní forma:</label>
      <select name="forma" id="id6">
        <option value="as">Akciová společnost</option>
        <option value="sro">Společnost s r.o.</option>
      </select>
    `
    expect(parsePravniForma(searchForm)).toBe(null)
  })

  it('follows search → detail link when first page lacks data', async () => {
    const searchHtml = `
      <html><body>
        <ul class="result-links">
          <li><a href="./rejstrik-firma.vysledky?subjektId=526277&amp;typ=PLATNY&amp;sp=TOKEN">Výpis platných</a></li>
        </ul>
      </body></html>
    `
    let calls = 0
    const facts = await probeJustice('12345678', {
      fetch: async (url) => {
        calls++
        if (calls === 1) return { ok: true, status: 200, text: async () => searchHtml }
        if (calls === 2) return { ok: true, status: 200, text: async () => FIXTURE }
        throw new Error('unexpected extra call')
      },
    })
    expect(calls).toBe(2)
    const by = Object.fromEntries(facts.map(f => [f.field, f.value]))
    expect(by.pravni_forma).toBe('Akciová společnost')
    expect(by.datum_vzniku).toBe('2015-03-12')
    expect(by.justice_cz_status).toBe('ok')
  })
})

describe('extractDetailUrl', () => {
  it('extracts absolute detail URL from search results', () => {
    const html = `<a href="./rejstrik-firma.vysledky?subjektId=42&amp;typ=PLATNY&amp;sp=X">Výpis platných</a>`
    const abs = extractDetailUrl(html, 'https://or.justice.cz/ias/ui/rejstrik-$firma?ico=123')
    expect(abs).toContain('subjektId=42')
    expect(abs).toContain('typ=PLATNY')
    expect(abs).toContain('sp=X')
    expect(abs.startsWith('https://or.justice.cz/')).toBe(true)
  })

  it('returns null when search missed', () => {
    expect(extractDetailUrl('<html>no results</html>', 'https://x/')).toBe(null)
    expect(extractDetailUrl(null, 'https://x/')).toBe(null)
  })
})
