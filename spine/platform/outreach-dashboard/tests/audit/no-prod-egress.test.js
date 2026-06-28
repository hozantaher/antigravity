// ═══════════════════════════════════════════════════════════════════════════
//  AUDIT RATCHET — tests must not touch production.
//
//  Locks in the no-prod-egress guard (tests/setup/no-prod-egress.js) so it can't
//  be silently removed or weakened. Incident 2026-06-25: a contract test created
//  16 junk campaigns in prod because the local .env pointed GO_SERVER_URL at prod
//  Go and the test forwarded a POST there. See the setup file header.
//
//  If this fails: do NOT relax it to go green. Re-wire the guard / fix the
//  leaking test instead.
// ═══════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, it, expect } from 'vitest'
import {
  PROD_HOST_PATTERNS,
  scrubProdEnv,
  hostOf,
  installFetchGuard,
} from '../setup/no-prod-egress.js'

describe('no-prod-egress ratchet', () => {
  it('is wired as the FIRST setup file in every vitest scope', () => {
    const cfg = readFileSync(resolve(__dirname, '../../vitest.config.ts'), 'utf8')
    expect(cfg).toMatch(/const NO_PROD_EGRESS = '\.\/tests\/setup\/no-prod-egress\.js'/)
    const arrays = [...cfg.matchAll(/setupFiles:\s*\[([^\]]*)\]/g)].map((m) => m[1].trim())
    // default / contract / integration / all
    expect(arrays.length).toBeGreaterThanOrEqual(4)
    for (const a of arrays) {
      expect(a.startsWith('NO_PROD_EGRESS')).toBe(true)
    }
  })

  it('recognises prod hosts and extracts hostnames', () => {
    expect(PROD_HOST_PATTERNS.some((re) => re.test('x.up.railway.app'))).toBe(true)
    expect(PROD_HOST_PATTERNS.some((re) => re.test('junction.proxy.rlwy.net'))).toBe(true)
    expect(hostOf('https://machinery-outreach-production.up.railway.app/api/campaigns'))
      .toBe('machinery-outreach-production.up.railway.app')
    expect(hostOf('http://127.0.0.1:18001/api')).toBe('127.0.0.1')
    expect(hostOf('/api/campaigns')).toBe('localhost') // relative → same origin
  })

  it('fetch guard rejects a prod host but passes loopback through', async () => {
    const saved = globalThis.fetch
    try {
      let reached = null
      const dummy = (u) => { reached = u; return Promise.resolve('ok') }
      dummy.__noProdGuard = false
      globalThis.fetch = dummy
      expect(installFetchGuard()).toBe(true)
      await expect(globalThis.fetch('https://x.up.railway.app/v1/submit')).rejects.toThrow(/no-prod-egress/)
      await globalThis.fetch('http://127.0.0.1:9/health')
      expect(reached).toBe('http://127.0.0.1:9/health')
    } finally {
      globalThis.fetch = saved
    }
  })

  it('scrubProdEnv neutralizes a prod-pointing env var', () => {
    const KEY = '__TEST_PROD_LEAK_PROBE__'
    process.env[KEY] = 'https://foo.up.railway.app'
    try {
      scrubProdEnv()
      expect(process.env[KEY]).toBe('')
    } finally {
      delete process.env[KEY]
    }
  })

  it('no live env var points at a prod host (rlwy.net / railway.app)', () => {
    const offenders = Object.entries(process.env)
      .filter(([, v]) => typeof v === 'string' && /rlwy\.net|railway\.app/i.test(v))
      .map(([k]) => k)
    expect(offenders).toEqual([])
  })
})
