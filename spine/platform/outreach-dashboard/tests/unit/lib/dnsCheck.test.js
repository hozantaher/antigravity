import { describe, it, expect } from 'vitest'
import { checkMX, checkSPF, checkDKIM, runDNSCheck } from '../../../src/lib/dnsCheck.js'

// ── helpers ───────────────────────────────────────────────────────────────

function makeMxFn(records) {
  return () => Promise.resolve(records)
}

function makeTxtFn(byName) {
  return (name) => {
    if (byName[name]) return Promise.resolve(byName[name])
    const e = new Error(`ENOTFOUND: ${name}`)
    e.code = 'ENOTFOUND'
    return Promise.reject(e)
  }
}

function makeTxtError(msg = 'NXDOMAIN', code = 'ENOTFOUND') {
  return () => { const e = new Error(msg); e.code = code; return Promise.reject(e) }
}

// ── checkMX ───────────────────────────────────────────────────────────────

describe('checkMX', () => {
  it('returns ok:true and sorted records array on success', async () => {
    const result = await checkMX('seznam.cz', {
      resolveMx: makeMxFn([
        { priority: 20, exchange: 'mx2.seznam.cz' },
        { priority: 10, exchange: 'mx1.seznam.cz' },
      ]),
    })
    expect(result.ok).toBe(true)
    expect(result.records).toEqual(['mx1.seznam.cz', 'mx2.seznam.cz'])
    expect(result.error).toBeUndefined()
  })

  it('returns ok:false with empty records on DNS failure', async () => {
    const result = await checkMX('dead.cz', {
      resolveMx: makeTxtError('ENOTFOUND'),
    })
    expect(result.ok).toBe(false)
    expect(result.records).toEqual([])
    expect(result.error).toBeTruthy()
  })

  it('returns ok:false when MX list is empty', async () => {
    const result = await checkMX('nomx.cz', { resolveMx: makeMxFn([]) })
    expect(result.ok).toBe(false)
    expect(result.records).toEqual([])
  })

  it('handles null return from resolver gracefully', async () => {
    const result = await checkMX('null.cz', { resolveMx: () => Promise.resolve(null) })
    expect(result.ok).toBe(false)
    expect(result.records).toEqual([])
  })
})

// ── checkSPF ──────────────────────────────────────────────────────────────

describe('checkSPF', () => {
  it('returns ok:true with record string when SPF exists', async () => {
    const result = await checkSPF('seznam.cz', {
      resolveTxt: makeTxtFn({
        'seznam.cz': [['v=spf1 include:_spf.seznam.cz -all']],
      }),
    })
    expect(result.ok).toBe(true)
    expect(result.record).toMatch(/^v=spf1/)
    expect(result.error).toBeUndefined()
  })

  it('returns ok:false when no SPF TXT record present', async () => {
    const result = await checkSPF('nospf.cz', {
      resolveTxt: makeTxtFn({ 'nospf.cz': [['v=DMARC1; p=none']] }),
    })
    expect(result.ok).toBe(false)
    expect(result.record).toBeNull()
  })

  it('returns ok:false on DNS error', async () => {
    const result = await checkSPF('dead.cz', { resolveTxt: makeTxtError() })
    expect(result.ok).toBe(false)
    expect(result.record).toBeNull()
    expect(result.error).toBeTruthy()
  })

  it('handles flat (non-nested) TXT array', async () => {
    const result = await checkSPF('flat.cz', {
      resolveTxt: () => Promise.resolve(['v=spf1 mx ~all']),
    })
    expect(result.ok).toBe(true)
    expect(result.record).toBe('v=spf1 mx ~all')
  })
})

// ── checkDKIM ─────────────────────────────────────────────────────────────

describe('checkDKIM', () => {
  it('returns ok:true when DKIM1 record found at selector._domainkey.domain', async () => {
    const result = await checkDKIM('seznam.cz', 'default', {
      resolveTxt: makeTxtFn({
        'default._domainkey.seznam.cz': [['v=DKIM1; k=rsa; p=MIIBIjAN...']],
      }),
    })
    expect(result.ok).toBe(true)
    expect(result.record).toMatch(/v=DKIM1/)
    expect(result.selector).toBe('default')
  })

  it('returns ok:false on NXDOMAIN (selector not published)', async () => {
    const result = await checkDKIM('nodkim.cz', 'google', { resolveTxt: makeTxtError() })
    expect(result.ok).toBe(false)
    expect(result.record).toBeNull()
    expect(result.selector).toBe('google')
    expect(result.error).toBeTruthy()
  })

  it('returns ok:false when TXT exists but no DKIM1 entry', async () => {
    const result = await checkDKIM('nodkim.cz', 'default', {
      resolveTxt: makeTxtFn({ 'default._domainkey.nodkim.cz': [['something-else']] }),
    })
    expect(result.ok).toBe(false)
    expect(result.record).toBeNull()
  })

  it('preserves selector in result', async () => {
    const result = await checkDKIM('firma.cz', 'selector1', { resolveTxt: makeTxtError() })
    expect(result.selector).toBe('selector1')
  })
})

// ── runDNSCheck ───────────────────────────────────────────────────────────

describe('runDNSCheck', () => {
  it('extracts "seznam.cz" from "smtp.seznam.cz"', async () => {
    const txtDeps = makeTxtFn({ 'seznam.cz': [['v=spf1 -all']] })
    const result = await runDNSCheck('smtp.seznam.cz', 'default', {
      resolveMx:  makeMxFn([{ priority: 10, exchange: 'mx1.seznam.cz' }]),
      resolveTxt: txtDeps,
    })
    expect(result.domain).toBe('seznam.cz')
  })

  it('handles single-part smtpHost without crash', async () => {
    const result = await runDNSCheck('localhost', 'default', {
      resolveMx:  makeMxFn([]),
      resolveTxt: makeTxtError(),
    })
    expect(result).toBeDefined()
    expect(result.domain).toBe('localhost')
  })

  it('ok:true when MX ok + SPF ok (DKIM irrelevant)', async () => {
    const result = await runDNSCheck('smtp.firma.cz', 'default', {
      resolveMx:  makeMxFn([{ priority: 10, exchange: 'mx.firma.cz' }]),
      resolveTxt: makeTxtFn({
        'firma.cz': [['v=spf1 mx -all']],
      }),
    })
    expect(result.ok).toBe(true)
    expect(result.mx.ok).toBe(true)
    expect(result.spf.ok).toBe(true)
  })

  it('ok:false when MX ok but SPF fails', async () => {
    const result = await runDNSCheck('smtp.firma.cz', 'default', {
      resolveMx:  makeMxFn([{ priority: 10, exchange: 'mx.firma.cz' }]),
      resolveTxt: makeTxtFn({ 'firma.cz': [['v=DMARC1; p=none']] }),
    })
    expect(result.ok).toBe(false)
    expect(result.mx.ok).toBe(true)
    expect(result.spf.ok).toBe(false)
  })

  it('ok:false when MX fails (even if SPF would succeed)', async () => {
    const result = await runDNSCheck('smtp.firma.cz', 'default', {
      resolveMx:  makeMxFn([]),
      resolveTxt: makeTxtFn({ 'firma.cz': [['v=spf1 -all']] }),
    })
    expect(result.ok).toBe(false)
    expect(result.mx.ok).toBe(false)
  })

  it('returns ok:false immediately for empty/falsy smtpHost', async () => {
    const r1 = await runDNSCheck('')
    expect(r1.ok).toBe(false)
    expect(r1.mx.ok).toBe(false)

    const r2 = await runDNSCheck(null)
    expect(r2.ok).toBe(false)
  })

  it('includes dkim sub-result regardless of its ok value', async () => {
    const result = await runDNSCheck('smtp.firma.cz', 'default', {
      resolveMx:  makeMxFn([{ priority: 10, exchange: 'mx.firma.cz' }]),
      resolveTxt: makeTxtFn({ 'firma.cz': [['v=spf1 -all']] }),
    })
    expect(result.dkim).toBeDefined()
    expect(result.dkim.selector).toBe('default')
  })

  it('MONKEY: arbitrary smtp_host strings do not throw', async () => {
    const weirdHosts = [
      'a', '..', 'a.b.c.d.e', 'foo..bar', '123', 'UPPERCASE.COM',
      'múj.cz', '', undefined, null, 'smtp.', '.smtp', 'x.y',
    ]
    const safeDeps = {
      resolveMx:  makeMxFn([]),
      resolveTxt: makeTxtError(),
    }
    for (const host of weirdHosts) {
      await expect(runDNSCheck(host, 'default', safeDeps)).resolves.toBeDefined()
    }
  })
})
