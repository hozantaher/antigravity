import { describe, it, expect } from 'vitest'
import {
  parseTenderRows,
  summarizeTenders,
  probeVvz,
} from '../../../src/lib/vvz.js'

const FIXTURE = `
<html><body>
<table class="results">
  <tr class="resultRow">
    <td><a href="/Detail/abc">Stavební práce — rekonstrukce silnice II/150</a></td>
    <td>Zadavatel X</td>
    <td>15. 3. 2025</td>
    <td>2 500 000,00 Kč</td>
  </tr>
  <tr class="resultRow">
    <td><a href="/Detail/def">Dodávka kolového nakladače</a></td>
    <td>Zadavatel Y</td>
    <td>1. 6. 2024</td>
    <td>1 800 000 Kč</td>
  </tr>
  <tr class="resultRow">
    <td><a href="/Detail/old">Starý projekt</a></td>
    <td>Zadavatel Z</td>
    <td>5. 1. 2019</td>
    <td>500 000 Kč</td>
  </tr>
</table>
</body></html>
`

const NOW_FIXTURE = new Date('2026-04-19T00:00:00Z').getTime()

describe('parseTenderRows', () => {
  it('extracts rows with subject/date/value', () => {
    const rows = parseTenderRows(FIXTURE)
    expect(rows.length).toBe(3)
    expect(rows[0].subject).toContain('rekonstrukce silnice')
    expect(rows[0].date).toBe('2025-03-15')
    expect(rows[0].value).toBe(2_500_000)
    expect(rows[1].value).toBe(1_800_000)
  })

  it('returns [] on no-results marker', () => {
    expect(parseTenderRows('<div>Nebyly nalezeny žádné záznamy</div>')).toEqual([])
  })

  it('null/empty safe', () => {
    expect(parseTenderRows(null)).toEqual([])
    expect(parseTenderRows('')).toEqual([])
    expect(parseTenderRows('<html>no rows</html>')).toEqual([])
  })
})

describe('summarizeTenders', () => {
  it('filters by lookback window', () => {
    const rows = parseTenderRows(FIXTURE)
    const s = summarizeTenders(rows, { lookbackYears: 3, now: NOW_FIXTURE })
    expect(s.tendr_count).toBe(2)
    expect(s.tendr_last_date).toBe('2025-03-15')
    expect(s.tendr_total_value_kc).toBe(4_300_000)
    expect(s.tendr_subjects.length).toBe(2)
  })

  it('wider window includes older tenders', () => {
    const rows = parseTenderRows(FIXTURE)
    const s = summarizeTenders(rows, { lookbackYears: 20, now: NOW_FIXTURE })
    expect(s.tendr_count).toBe(3)
    expect(s.tendr_total_value_kc).toBe(4_800_000)
  })

  it('caps subjects at 5', () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      subject: `subj-${i}`, date: '2025-01-01', value: 100,
    }))
    const s = summarizeTenders(rows, { now: NOW_FIXTURE })
    expect(s.tendr_subjects.length).toBe(5)
  })

  it('empty input → zero counts', () => {
    const s = summarizeTenders([], { now: NOW_FIXTURE })
    expect(s.tendr_count).toBe(0)
    expect(s.tendr_last_date).toBe(null)
    expect(s.tendr_total_value_kc).toBe(null)
  })
})

describe('probeVvz — orchestration', () => {
  const mockFetch = (response) => async () => ({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    text: async () => response.html ?? '',
  })

  it('emits facts on fixture', async () => {
    const facts = await probeVvz('12345678', {
      fetch: mockFetch({ html: FIXTURE }),
      now: NOW_FIXTURE,
    })
    const by = Object.fromEntries(facts.map(f => [f.field, f.value]))
    expect(by.vvz_status).toBe('ok')
    expect(by.tendr_count).toBe(2)
    expect(by.tendr_last_date).toBe('2025-03-15')
    expect(by.tendr_total_value_kc).toBe(4_300_000)
  })

  it('no_match when page empty', async () => {
    const facts = await probeVvz('12345678', {
      fetch: mockFetch({ html: '<html>Nebyly nalezeny žádné záznamy</html>' }),
    })
    const by = Object.fromEntries(facts.map(f => [f.field, f.value]))
    expect(by.vvz_status).toBe('no_match')
    expect(by.tendr_count).toBe(0)
  })

  it('pads short ICO in URL', async () => {
    let capturedUrl = ''
    await probeVvz('123', {
      fetch: async (url) => {
        capturedUrl = url
        return { ok: true, status: 200, text: async () => '' }
      },
    })
    expect(capturedUrl).toContain('ico=00000123')
  })

  it('rejects invalid ICO', async () => {
    await expect(probeVvz('abc', { fetch: async () => ({}) })).rejects.toThrow(/invalid ico/)
    await expect(probeVvz(null, { fetch: async () => ({}) })).rejects.toThrow(/invalid ico/)
  })

  it('http error → http_NNN status', async () => {
    const facts = await probeVvz('12345678', {
      fetch: mockFetch({ ok: false, status: 500 }),
    })
    const by = Object.fromEntries(facts.map(f => [f.field, f.value]))
    expect(by.vvz_status).toBe('http_500')
  })

  it('timeout → timeout status', async () => {
    const facts = await probeVvz('12345678', {
      fetch: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) },
    })
    const by = Object.fromEntries(facts.map(f => [f.field, f.value]))
    expect(by.vvz_status).toBe('timeout')
  })

  it('network failure → unreachable', async () => {
    const facts = await probeVvz('12345678', {
      fetch: async () => { throw new Error('econnrefused') },
    })
    const by = Object.fromEntries(facts.map(f => [f.field, f.value]))
    expect(by.vvz_status).toBe('unreachable')
  })

  it('omits tendr_total_value_kc when all rows lack value', async () => {
    const html = `
      <tr class="resultRow">
        <td><a href="/Detail/a">Subj</a></td>
        <td>Zadavatel</td>
        <td>1. 2. 2025</td>
      </tr>
    `
    const facts = await probeVvz('12345678', {
      fetch: mockFetch({ html }),
      now: NOW_FIXTURE,
    })
    const by = Object.fromEntries(facts.map(f => [f.field, f.value]))
    expect(by.tendr_count).toBe(1)
    expect(by.tendr_total_value_kc).toBeUndefined()
  })

  it('reflects parser version', () => {
    expect(probeVvz.version).toBe('vvz_v1')
  })
})
