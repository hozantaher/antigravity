import { describe, it, expect } from 'vitest'
import { checkBlacklist, DNSBL_ZONES } from '../../../src/lib/blacklistCheck.js'

// ── helpers ───────────────────────────────────────────────────────────────

/**
 * Build a mock `dns` object.
 *
 * @param {{ resolve4?: Record<string,string[]|Error>, resolveMx?: Record<string,Array<{priority:number,exchange:string}>|Error> }} config
 */
function makeDns({ resolve4 = {}, resolveMx = {} } = {}) {
  return {
    resolve4(hostname) {
      const val = resolve4[hostname]
      if (!val) {
        const e = new Error(`ENOTFOUND ${hostname}`)
        e.code = 'ENOTFOUND'
        return Promise.reject(e)
      }
      if (val instanceof Error) return Promise.reject(val)
      return Promise.resolve(val)
    },
    resolveMx(hostname) {
      const val = resolveMx[hostname]
      if (!val) {
        const e = new Error(`ENOTFOUND ${hostname}`)
        e.code = 'ENOTFOUND'
        return Promise.reject(e)
      }
      if (val instanceof Error) return Promise.reject(val)
      return Promise.resolve(val)
    },
  }
}

/** Reversed IP for DNSBL lookup: "1.2.3.4" → "4.3.2.1" */
function reversed(ip) { return ip.split('.').reverse().join('.') }

// ── Test 1: IP not listed → listed:false, hits:[] ─────────────────────────

describe('checkBlacklist — not listed', () => {
  it('returns listed:false and empty hits when no zone returns A record', async () => {
    const ip = '93.184.216.34'
    const dns = makeDns({ resolve4: { 'smtp.example.com': [ip] } })
    // All DNSBL lookups will ENOTFOUND (not in the resolve4 map)
    const result = await checkBlacklist('smtp.example.com', { dns })
    expect(result.listed).toBe(false)
    expect(result.hits).toEqual([])
    expect(result.ips).toEqual([ip])
    expect(result.checked_at).toBeTruthy()
    expect(result.error).toBeUndefined()
  })
})

// ── Test 2: IP listed on zen.spamhaus.org ─────────────────────────────────

describe('checkBlacklist — zen.spamhaus.org hit', () => {
  it('returns listed:true with correct zone and ip in hits', async () => {
    const ip = '1.2.3.4'
    const rev = reversed(ip)
    const dns = makeDns({
      resolve4: {
        'smtp.spammer.net': [ip],
        [`${rev}.zen.spamhaus.org`]: ['127.0.0.2'],
      },
    })
    const result = await checkBlacklist('smtp.spammer.net', { dns })
    expect(result.listed).toBe(true)
    expect(result.hits).toContainEqual({ zone: 'zen.spamhaus.org', ip })
    expect(result.hits.length).toBe(1)
  })
})

// ── Test 3: IP listed on multiple zones ───────────────────────────────────

describe('checkBlacklist — multiple zone hits', () => {
  it('accumulates a hit for every zone that returns an A record', async () => {
    const ip = '5.6.7.8'
    const rev = reversed(ip)
    const dns = makeDns({
      resolve4: {
        'smtp.badactor.biz': [ip],
        [`${rev}.zen.spamhaus.org`]: ['127.0.0.2'],
        [`${rev}.bl.spamcop.net`]: ['127.0.0.2'],
        [`${rev}.b.barracudacentral.org`]: ['127.0.0.2'],
      },
    })
    const result = await checkBlacklist('smtp.badactor.biz', { dns })
    expect(result.listed).toBe(true)
    expect(result.hits.length).toBeGreaterThan(1)
    const zones = result.hits.map(h => h.zone)
    expect(zones).toContain('zen.spamhaus.org')
    expect(zones).toContain('bl.spamcop.net')
    expect(zones).toContain('b.barracudacentral.org')
  })
})

// ── Test 4: resolve4 fails → fallback to MX lookup ────────────────────────

describe('checkBlacklist — resolve4 fails, fallback to MX', () => {
  it('resolves IP via MX exchange when direct A lookup fails', async () => {
    const ip = '10.20.30.40'
    const rev = reversed(ip)
    // Direct A lookup for smtp.host fails; MX for 'host.cz' succeeds
    const dns = makeDns({
      resolve4: {
        'mx1.host.cz': [ip],                            // MX exchange resolves fine
        [`${rev}.zen.spamhaus.org`]: ['127.0.0.2'],
      },
      resolveMx: {
        'host.cz': [{ priority: 10, exchange: 'mx1.host.cz' }],
      },
    })
    const result = await checkBlacklist('smtp.host.cz', { dns })
    expect(result.ips).toEqual([ip])
    expect(result.listed).toBe(true)
    expect(result.hits[0].ip).toBe(ip)
  })
})

// ── Test 5: MX lookup also fails → error:'no_ip_resolved', listed:false ───

describe('checkBlacklist — both resolve4 and MX fail', () => {
  it('returns error:no_ip_resolved and listed:false without throwing', async () => {
    const dns = makeDns() // nothing in the maps → all ENOTFOUND
    const result = await checkBlacklist('totally.unknown.host.example', { dns })
    expect(result.listed).toBe(false)
    expect(result.hits).toEqual([])
    expect(result.ips).toEqual([])
    expect(result.error).toBe('no_ip_resolved')
  })
})

// ── Test 6: Unresolvable host → no crash, error set ──────────────────────

describe('checkBlacklist — unresolvable host', () => {
  it('does not throw and returns error flag for a garbage hostname', async () => {
    const dns = makeDns()
    const result = await checkBlacklist('not-a-real-host-abc123.invalid', { dns })
    expect(result).toBeDefined()
    expect(result.error).toBe('no_ip_resolved')
    expect(result.listed).toBe(false)
  })
})

// ── Test 7: All zones clean → listed:false ────────────────────────────────

describe('checkBlacklist — all zones clean', () => {
  it('returns listed:false when all DNSBL lookups fail (not listed)', async () => {
    const ip = '203.0.113.1'
    const dns = makeDns({ resolve4: { 'smtp.clean.org': [ip] } })
    const result = await checkBlacklist('smtp.clean.org', { dns })
    expect(result.listed).toBe(false)
    expect(result.hits).toHaveLength(0)
    expect(result.ips).toEqual([ip])
  })
})

// ── Test 8: Reversed IP format ────────────────────────────────────────────

describe('checkBlacklist — reversed IP format', () => {
  it('constructs DNSBL lookup as reversed-ip.zone (e.g. 4.3.2.1.zen.spamhaus.org)', async () => {
    const ip = '1.2.3.4'
    const capturedLookups = []
    const dns = {
      resolve4(hostname) {
        capturedLookups.push(hostname)
        // Always ENOTFOUND so we don't get hits — we just want to observe the lookup name
        const e = new Error(`ENOTFOUND ${hostname}`)
        e.code = 'ENOTFOUND'
        // For the initial smtp host lookup return the IP
        if (hostname === 'smtp.test.cz') return Promise.resolve([ip])
        return Promise.reject(e)
      },
      resolveMx() {
        const e = new Error('ENOTFOUND'); e.code = 'ENOTFOUND'; return Promise.reject(e)
      },
    }
    await checkBlacklist('smtp.test.cz', { dns })
    // All DNSBL lookups should start with reversed IP
    const dnsblLookups = capturedLookups.filter(h => h !== 'smtp.test.cz')
    for (const lookup of dnsblLookups) {
      expect(lookup).toMatch(/^4\.3\.2\.1\./)
    }
    // Specifically check spamhaus zone
    expect(dnsblLookups).toContain('4.3.2.1.zen.spamhaus.org')
  })
})

// ── Test 9: MONKEY — random smtp_host strings → no crash ──────────────────

describe('checkBlacklist — MONKEY fuzz no crash', () => {
  const weirdHosts = [
    'a', '..', 'a.b.c.d.e.f', 'foo..bar', '123', 'UPPERCASE.COM',
    'múj.cz', '', ' ', '\t', null, undefined, 42, {}, [],
    'smtp.', '.smtp', 'x.y', '0.0.0.0', '255.255.255.255',
    'very-long-host-name-that-should-not-cause-issues.example.com',
  ]

  for (const host of weirdHosts) {
    it(`does not throw for input ${JSON.stringify(host)}`, async () => {
      const dns = makeDns() // everything ENOTFOUND
      // Should always resolve (never reject) regardless of input
      await expect(
        checkBlacklist(host, { dns })
      ).resolves.toMatchObject({
        listed: expect.any(Boolean),
        hits: expect.any(Array),
      })
    })
  }
})

// ── Test 10: checkBlacklist("smtp.seznam.cz") — mock DNS, no crash ────────

describe('checkBlacklist("smtp.seznam.cz")', () => {
  it('runs without crash and returns a valid result object (mock DNS)', async () => {
    const ip = '77.75.72.3'
    const rev = reversed(ip)
    const dns = makeDns({
      resolve4: {
        'smtp.seznam.cz': [ip],
        // Not listed on any zone (all ENOTFOUND for dnsbl)
      },
    })
    const result = await checkBlacklist('smtp.seznam.cz', { dns })
    expect(result).toMatchObject({
      listed: false,
      hits: [],
      ips: [ip],
    })
    expect(typeof result.checked_at).toBe('string')
  })
})

// ── Test 11: listed:true → hits array has zone + ip fields ────────────────

describe('checkBlacklist — hit object shape', () => {
  it('every hit has both zone (string) and ip (string) fields', async () => {
    const ip = '192.0.2.99'
    const rev = reversed(ip)
    const dns = makeDns({
      resolve4: {
        'smtp.listed.io': [ip],
        [`${rev}.zen.spamhaus.org`]: ['127.0.0.2'],
        [`${rev}.dnsbl.sorbs.net`]: ['127.0.0.10'],
      },
    })
    const result = await checkBlacklist('smtp.listed.io', { dns })
    expect(result.listed).toBe(true)
    for (const hit of result.hits) {
      expect(typeof hit.zone).toBe('string')
      expect(typeof hit.ip).toBe('string')
      expect(hit.zone.length).toBeGreaterThan(0)
      expect(hit.ip.length).toBeGreaterThan(0)
    }
  })
})

// ── Test 12: Empty DNSBL_ZONES override → listed:false ────────────────────

describe('checkBlacklist — empty zones list', () => {
  it('returns listed:false when no zones are configured', async () => {
    const ip = '198.51.100.1'
    const dns = makeDns({ resolve4: { 'smtp.empty-zones.test': [ip] } })
    const result = await checkBlacklist('smtp.empty-zones.test', { dns, zones: [] })
    expect(result.listed).toBe(false)
    expect(result.hits).toHaveLength(0)
    expect(result.ips).toEqual([ip])
  })
})

// ── Test 13: Multiple IPs — each checked across all zones ─────────────────

describe('checkBlacklist — multiple IPs from resolve4', () => {
  it('checks all returned IPs when a host has multiple A records', async () => {
    const ip1 = '10.0.0.1'
    const ip2 = '10.0.0.2'
    const rev2 = reversed(ip2)
    const dns = makeDns({
      resolve4: {
        'smtp.multi.io': [ip1, ip2],
        [`${rev2}.bl.spamcop.net`]: ['127.0.0.2'],
      },
    })
    const result = await checkBlacklist('smtp.multi.io', { dns })
    expect(result.ips).toEqual([ip1, ip2])
    expect(result.listed).toBe(true)
    expect(result.hits.some(h => h.ip === ip2 && h.zone === 'bl.spamcop.net')).toBe(true)
  })
})

// ── Test 14: checked_at is an ISO 8601 timestamp ──────────────────────────

describe('checkBlacklist — checked_at field', () => {
  it('returns a valid ISO timestamp in checked_at', async () => {
    const dns = makeDns({ resolve4: { 'smtp.time.test': ['1.1.1.1'] } })
    const result = await checkBlacklist('smtp.time.test', { dns })
    expect(() => new Date(result.checked_at)).not.toThrow()
    expect(new Date(result.checked_at).toISOString()).toBe(result.checked_at)
  })
})
