import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getRelayBase, relayFetch, relaySmtpCheck, relaySmtpAuthProbe, relayProxyPool } from '../../../src/lib/relayClient.js'

// Helper — minimal pool stub used by getRelayBase. Each test overrides
// .query() to control the DB leg of the resolver.
function makePool(queryImpl) {
  return { query: queryImpl }
}

// ── getRelayBase ─────────────────────────────────────────────────────────────

describe('getRelayBase — resolver precedence', () => {
  const savedEnv = { ...process.env }

  beforeEach(() => {
    delete process.env.ANTI_TRACE_RELAY_URL_OVERRIDE
    delete process.env.ANTI_TRACE_RELAY_URL
  })

  afterEach(() => {
    process.env = { ...savedEnv }
  })

  it('returns ANTI_TRACE_RELAY_URL_OVERRIDE when set (highest precedence)', async () => {
    process.env.ANTI_TRACE_RELAY_URL_OVERRIDE = 'http://127.0.0.1:8089'
    process.env.ANTI_TRACE_RELAY_URL = 'https://should.not.win'
    const pool = makePool(async () => ({ rows: [{ value: 'https://db.should.not.win' }] }))
    await expect(getRelayBase(pool)).resolves.toBe('http://127.0.0.1:8089')
  })

  it('strips trailing slashes from override', async () => {
    process.env.ANTI_TRACE_RELAY_URL_OVERRIDE = 'http://127.0.0.1:8089///'
    const pool = makePool(async () => ({ rows: [] }))
    await expect(getRelayBase(pool)).resolves.toBe('http://127.0.0.1:8089')
  })

  it('returns DB value when override is unset', async () => {
    const pool = makePool(async () => ({ rows: [{ value: 'https://db-relay.example.com/' }] }))
    await expect(getRelayBase(pool)).resolves.toBe('https://db-relay.example.com')
  })

  it('falls back to ANTI_TRACE_RELAY_URL when DB has no row', async () => {
    process.env.ANTI_TRACE_RELAY_URL = 'https://env-relay.example.com/'
    const pool = makePool(async () => ({ rows: [] }))
    await expect(getRelayBase(pool)).resolves.toBe('https://env-relay.example.com')
  })

  it('falls back to ANTI_TRACE_RELAY_URL when DB query throws', async () => {
    process.env.ANTI_TRACE_RELAY_URL = 'https://env-relay.example.com'
    const pool = makePool(async () => { throw new Error('db down') })
    await expect(getRelayBase(pool)).resolves.toBe('https://env-relay.example.com')
  })

  it('returns null when nothing is configured', async () => {
    const pool = makePool(async () => ({ rows: [] }))
    await expect(getRelayBase(pool)).resolves.toBeNull()
  })

  // Regression — the bug that motivated unifying pingAntiTrace and the
  // relay client: when a dev sets the env override, the health ping must
  // follow it even if the DB still holds the old URL.
  it('regression: env override beats stale DB value (pingAntiTrace false-red fix)', async () => {
    process.env.ANTI_TRACE_RELAY_URL_OVERRIDE = 'http://127.0.0.1:8089'
    const pool = makePool(async () => ({
      rows: [{ value: 'https://old-stale-relay.example.com' }],
    }))
    await expect(getRelayBase(pool)).resolves.toBe('http://127.0.0.1:8089')
  })
})

describe('getRelayBase — fetch target for pingAntiTrace', () => {
  const savedEnv = { ...process.env }
  afterEach(() => { process.env = { ...savedEnv } })

  it('produces a URL that /healthz can be appended to without double slashes', async () => {
    process.env.ANTI_TRACE_RELAY_URL_OVERRIDE = 'http://127.0.0.1:8089/'
    const pool = makePool(async () => ({ rows: [] }))
    const base = await getRelayBase(pool)
    expect(base + '/healthz').toBe('http://127.0.0.1:8089/healthz')
  })
})

// ── relaySmtpCheck retry logic ───────────────────────────────────────────────
//
// relaySmtpCheck uses /v1/probe with up to 3 retries on socks5 proxy
// connectivity failures. Tests verify:
//   - retry on socks5_dial failure (up to 3x)
//   - no retry on AUTH failure (proxy reached, creds rejected)
//   - success returned immediately without consuming retries
//   - relay HTTP error stops the loop immediately
//   - MONKEY — 10 malformed response shapes never throw
//
// All tests stub global fetch — no real network calls.

/** Build a minimal /v1/probe response body used by relaySmtpCheck. */
function probeBody({ ok = true, socks5Fail = false, ms = 50 } = {}) {
  const steps = socks5Fail
    ? [{ name: 'socks_dial', ok: false, ms: 5, msg: 'socks5 connection refused' }]
    : [
        { name: 'socks_dial', ok: true, ms: 5 },
        { name: 'smtp_auth', ok, ms: 45, msg: ok ? null : '535 AUTH failed' },
      ]
  return { checks: { smtp: { ok, ms, steps } } }
}

/** Fake fetch Response from an object body. */
function fakeResp(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  }
}

/** Build a vi.fn() that returns each response in sequence, repeating the last. */
function fetchSeq(...responses) {
  let i = 0
  return vi.fn(async () => {
    const r = responses[Math.min(i++, responses.length - 1)]
    return r
  })
}

describe('relaySmtpCheck — /v1/probe retry on socks5 failure', () => {
  const savedEnv = { ...process.env }

  beforeEach(() => {
    process.env.ANTI_TRACE_RELAY_URL_OVERRIDE = 'http://relay.local'
  })
  afterEach(() => {
    process.env = { ...savedEnv }
    vi.unstubAllGlobals()
  })

  it('returns success on 1st attempt — no extra calls made', async () => {
    const fetchMock = vi.fn(async () => fakeResp(probeBody({ ok: true })))
    vi.stubGlobal('fetch', fetchMock)

    const result = await relaySmtpCheck(null, 'smtp.ex.com', 587, 'u', 'p')

    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries on socks5 fail and succeeds on 2nd attempt', async () => {
    const fetchMock = fetchSeq(
      fakeResp(probeBody({ ok: false, socks5Fail: true })),
      fakeResp(probeBody({ ok: true })),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await relaySmtpCheck(null, 'smtp.ex.com', 587, 'u', 'p')

    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries up to 3x — returns last socks5 fail when all 3 fail', async () => {
    const fetchMock = fetchSeq(
      fakeResp(probeBody({ ok: false, socks5Fail: true })),
      fakeResp(probeBody({ ok: false, socks5Fail: true })),
      fakeResp(probeBody({ ok: false, socks5Fail: true })),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await relaySmtpCheck(null, 'smtp.ex.com', 587, 'u', 'p')

    expect(result.ok).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('succeeds on 3rd attempt (socks5 × 2, then success)', async () => {
    const fetchMock = fetchSeq(
      fakeResp(probeBody({ ok: false, socks5Fail: true })),
      fakeResp(probeBody({ ok: false, socks5Fail: true })),
      fakeResp(probeBody({ ok: true })),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await relaySmtpCheck(null, 'smtp.ex.com', 587, 'u', 'p')

    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('does NOT retry on AUTH failure — stops at 1 call', async () => {
    const fetchMock = vi.fn(async () => fakeResp(probeBody({ ok: false, socks5Fail: false })))
    vi.stubGlobal('fetch', fetchMock)

    const result = await relaySmtpCheck(null, 'smtp.ex.com', 587, 'u', 'p')

    expect(result.ok).toBe(false)
    // socks5_dial succeeded → not a proxy failure → no retry
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('HTTP 500 from relay stops loop immediately — 1 call, ok=false', async () => {
    const fetchMock = vi.fn(async () => fakeResp({ error: 'internal' }, 500))
    vi.stubGlobal('fetch', fetchMock)

    const result = await relaySmtpCheck(null, 'smtp.ex.com', 587, 'u', 'p')

    expect(result.ok).toBe(false)
    expect(result.steps.length).toBeGreaterThan(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('relay not configured → ok=false, fetch never called', async () => {
    delete process.env.ANTI_TRACE_RELAY_URL_OVERRIDE
    delete process.env.ANTI_TRACE_RELAY_URL
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await relaySmtpCheck(null, 'smtp.ex.com', 587, 'u', 'p')

    expect(result.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ── MONKEY: 10 malformed response variants — never throws ────────────────────

describe('relaySmtpCheck — MONKEY: malformed /v1/probe response shapes', () => {
  const savedEnv = { ...process.env }

  beforeEach(() => { process.env.ANTI_TRACE_RELAY_URL_OVERRIDE = 'http://relay.local' })
  afterEach(() => {
    process.env = { ...savedEnv }
    vi.unstubAllGlobals()
  })

  /** Variants of malformed / unexpected response bodies. */
  const monkeyVariants = [
    [null,                                                  'M1: null body'],
    [{},                                                    'M2: empty object'],
    [{ checks: null },                                      'M3: null checks'],
    [{ checks: {} },                                        'M4: empty checks'],
    [{ checks: { smtp: null } },                            'M5: null smtp field'],
    [{ checks: { smtp: {} } },                              'M6: empty smtp field'],
    [{ checks: { smtp: { ok: 'yes', steps: null } } },      'M7: string ok + null steps'],
    [{ checks: { smtp: { ok: true, steps: 'bad' } } },      'M8: string steps instead of array'],
    [{ ok: true, ms: 100 },                                 'M9: flat shape (old auth-check format)'],
    [{ checks: { smtp: { ok: false, steps: [null, undefined] } } }, 'M10: null/undefined step entries'],
  ]

  monkeyVariants.forEach(([variant, label]) => {
    it(`${label} — never throws, returns {ok, steps}`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => fakeResp(variant)))

      const result = await relaySmtpCheck(null, 'smtp.ex.com', 587, 'u', 'p')

      // Must always return an object with ok (boolean) and steps (array).
      // It is OK for ok to be false on malformed responses.
      expect(result).toBeDefined()
      expect(typeof result.ok).toBe('boolean')
      expect(Array.isArray(result.steps)).toBe(true)
    })
  })
})

// ── relaySmtpAuthProbe ───────────────────────────────────────────────────────

describe('relaySmtpAuthProbe', () => {
  const savedEnv = { ...process.env }

  beforeEach(() => { process.env.ANTI_TRACE_RELAY_URL_OVERRIDE = 'http://relay.local' })
  afterEach(() => {
    process.env = { ...savedEnv }
    vi.unstubAllGlobals()
  })

  it('returns ok=true + ms when relay reports success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResp({ ok: true, ms: 55, error: null })))

    const result = await relaySmtpAuthProbe(null, '1.2.3.4:1080', 'smtp.ex.com', 587, 'u', 'p')

    expect(result.ok).toBe(true)
    expect(typeof result.ms).toBe('number')
  })

  it('returns ok=false + reason on AUTH rejection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResp({ ok: false, ms: 80, error: '535 AUTH rejected' })))

    const result = await relaySmtpAuthProbe(null, '1.2.3.4:1080', 'smtp.ex.com', 587, 'u', 'p')

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('535 AUTH rejected')
  })
})

// ── relayFetch — not configured ──────────────────────────────────────────────

describe('relayFetch — relay not configured', () => {
  const savedEnv = { ...process.env }
  afterEach(() => { process.env = { ...savedEnv } })

  it('returns relay_not_configured error when no URL set', async () => {
    delete process.env.ANTI_TRACE_RELAY_URL_OVERRIDE
    delete process.env.ANTI_TRACE_RELAY_URL

    const result = await relayFetch(null, '/v1/probe', { method: 'POST', body: {} })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('relay_not_configured')
    expect(result.body).toBeNull()
  })
})

// ── relayProxyPool — auth_validated + quality_score ──────────────────────────

describe('relayProxyPool — auth_validated and quality_score', () => {
  const savedEnv = { ...process.env }

  beforeEach(() => { process.env.ANTI_TRACE_RELAY_URL_OVERRIDE = 'http://relay.local' })
  afterEach(() => {
    process.env = { ...savedEnv }
    vi.unstubAllGlobals()
  })

  function poolBody(entries) {
    return {
      working: entries,
      last_refresh: new Date().toISOString(),
      count: entries.length,
    }
  }

  it('auth_validated counts entries with auth_valid=true', async () => {
    const entries = [
      { addr: 'p1:1080', country: 'CZ', source: 'proxifly', auth_valid: true },
      { addr: 'p2:1080', country: 'DE', source: 'geonode',  auth_valid: true },
      { addr: 'p3:1080', country: 'PL', source: 'geonode',  auth_valid: false },
      { addr: 'p4:1080', country: 'SK', source: 'proxifly', auth_valid: false },
    ]
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify(poolBody(entries)),
    })))

    const result = await relayProxyPool(null)

    expect(result.auth_validated).toBe(2)
  })

  it('quality_score = auth_validated / working * 100 (rounded)', async () => {
    const entries = [
      { addr: 'p1:1080', country: 'CZ', auth_valid: true },
      { addr: 'p2:1080', country: 'CZ', auth_valid: true },
      { addr: 'p3:1080', country: 'CZ', auth_valid: false },
      { addr: 'p4:1080', country: 'CZ', auth_valid: false },
    ]
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify(poolBody(entries)),
    })))

    const result = await relayProxyPool(null)

    expect(result.quality_score).toBe(50)
  })

  it('quality_score = 0 when pool is empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify(poolBody([])),
    })))

    const result = await relayProxyPool(null)

    expect(result.quality_score).toBe(0)
    expect(result.auth_validated).toBe(0)
  })

  it('quality_score = 100 when all entries have auth_valid=true', async () => {
    const entries = [
      { addr: 'p1:1080', country: 'CZ', auth_valid: true },
      { addr: 'p2:1080', country: 'DE', auth_valid: true },
      { addr: 'p3:1080', country: 'SK', auth_valid: true },
    ]
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify(poolBody(entries)),
    })))

    const result = await relayProxyPool(null)

    expect(result.quality_score).toBe(100)
    expect(result.auth_validated).toBe(3)
  })

  it('auth_validated=0 when no entries have auth_valid=true', async () => {
    const entries = [
      { addr: 'p1:1080', country: 'CZ', auth_valid: false },
      { addr: 'p2:1080', country: 'DE', auth_valid: null },
      { addr: 'p3:1080', country: 'SK' /* auth_valid missing */ },
    ]
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify(poolBody(entries)),
    })))

    const result = await relayProxyPool(null)

    expect(result.auth_validated).toBe(0)
    expect(result.quality_score).toBe(0)
  })

  it('relay error → auth_validated=0, quality_score=0', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 503,
      text: async () => JSON.stringify({ error: 'relay_down' }),
    })))

    const result = await relayProxyPool(null)

    expect(result.auth_validated).toBe(0)
    expect(result.quality_score).toBe(0)
    expect(result.working).toEqual([])
  })
})
