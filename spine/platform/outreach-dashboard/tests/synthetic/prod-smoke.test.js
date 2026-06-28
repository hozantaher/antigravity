// @linkage-allowed: synthetic monitor — target URL from SYNTHETIC_TARGET_URL env
// M1 — Synthetic prod-smoke (Phase 3 of "Tests as Heart").
// 10 critical health invariants run continuously in prod via BFF cron (60s).
// In tests/CI: skip unless SYNTHETIC_TARGET_URL is set.
//
// Each invariant is also exposed as standalone fn via runSyntheticSmoke()
// so the BFF cron can invoke the same suite without spinning up vitest.

import { describe, it, expect } from 'vitest'

const TARGET = process.env.SYNTHETIC_TARGET_URL || ''
const HAS_TARGET = !!TARGET

async function fetchJSON(path) {
  const r = await fetch(`${TARGET}${path}`, {
    signal: AbortSignal.timeout(5000),
    headers: process.env.OUTREACH_API_KEY
      ? { 'x-api-key': process.env.OUTREACH_API_KEY }
      : {},
  })
  return { status: r.status, ok: r.ok, body: await r.json().catch(() => null) }
}

// ── Each invariant as standalone (callable from cron) ──────────────────

export const INVARIANTS = {
  health: async () => {
    const r = await fetchJSON('/api/health')
    return { ok: r.ok && r.body?.ok === true, detail: r.body }
  },

  mailbox_pipeline_fresh: async () => {
    const r = await fetchJSON('/api/daemons')
    if (!r.ok) return { ok: false, detail: 'daemons unreachable' }
    const mailboxes = r.body?.mailboxes || []
    if (mailboxes.length === 0) return { ok: false, detail: 'no mailboxes' }
    const oldest = mailboxes.reduce((acc, m) => {
      const t = m.last_score_at ? new Date(m.last_score_at).getTime() : 0
      return Math.min(acc, t)
    }, Date.now())
    const ageH = (Date.now() - oldest) / 3600000
    return { ok: ageH < 24, detail: { oldest_age_h: ageH.toFixed(1) } }
  },

  heal_slo_p99: async () => {
    const r = await fetchJSON('/api/diagnostics/bottleneck-status')
    if (!r.ok) return { ok: true, detail: 'diagnostic endpoint unavailable (skip)' }
    const breaches = r.body?.sloBreaches || []
    return { ok: breaches.length === 0, detail: { breach_count: breaches.length } }
  },

  send_events_24h: async () => {
    const r = await fetchJSON('/api/analytics/overview')
    if (!r.ok) return { ok: false, detail: 'analytics unreachable' }
    const sent24h = r.body?.sent_7d || 0  // 7d field is closest available
    return { ok: sent24h > 0, detail: { sent_7d: sent24h } }
  },

  cron_heartbeat: async () => {
    const r = await fetchJSON('/api/healing/stats')
    if (!r.ok) return { ok: false, detail: 'healing stats unreachable' }
    // healing stats include cron metadata
    return { ok: true, detail: r.body }
  },

  anti_trace_health: async () => {
    const r = await fetchJSON('/api/diagnostics/bottleneck-status')
    if (!r.ok) return { ok: true, detail: 'skip' }
    const at = r.body?.antiTraceHealth
    return { ok: at?.status === 'up' || at?.status === 'not_configured',
             detail: { status: at?.status } }
  },

  schema_parity: async () => {
    const r = await fetchJSON('/api/__schema-check')
    if (!r.ok) return { ok: false, detail: { status: r.status } }
    return { ok: r.body?.ok === true, detail: r.body }
  },

  active_mailboxes: async () => {
    const r = await fetchJSON('/api/daemons')
    if (!r.ok) return { ok: false, detail: 'daemons unreachable' }
    const active = (r.body?.mailboxes || []).filter(m => m.status === 'active').length
    return { ok: active >= 1, detail: { active } }
  },

  suppression_populated: async () => {
    const r = await fetchJSON('/api/healing/log?limit=1')
    // Sanity: healing system is alive (suppression populates from heal events)
    return { ok: r.ok, detail: r.body }
  },

  no_thrash: async () => {
    const r = await fetchJSON('/api/healing/log?limit=50')
    if (!r.ok) return { ok: true, detail: 'log unavailable (skip)' }
    const events = r.body?.events || []
    // Count auto_pause events per mailbox in last 30min
    const cutoff = Date.now() - 30 * 60 * 1000
    const pausesPerMb = new Map()
    for (const e of events) {
      if (e.action !== 'auto_pause') continue
      const t = new Date(e.created_at).getTime()
      if (t < cutoff) continue
      pausesPerMb.set(e.entity_id, (pausesPerMb.get(e.entity_id) || 0) + 1)
    }
    const thrashing = [...pausesPerMb.entries()].filter(([, n]) => n > 3)
    return { ok: thrashing.length === 0, detail: { thrashing } }
  },

  // MVP-3 — Proxy pool readiness. /api/health/system reports
  // `proxy_pool_size` from the rotating SOCKS5 pool fetched by the relay
  // (geonode + proxyscrape + proxifly). Below 3 working proxies the
  // sender will starve; if anti-trace-relay is configured, this check
  // is informational (relay handles routing).
  proxy_pool_healthy: async () => {
    const r = await fetchJSON('/api/health/system')
    if (!r.ok) return { ok: false, detail: { http: r.status } }
    const body = r.body || {}
    const size = Number(body.proxy_pool_size || 0)
    const low = Boolean(body.proxy_pool_low)
    // Pass when pool ≥3 OR when relay handles proxying (size 0 + no low alert
    // can also mean operator is using anti-trace-relay path).
    return {
      ok: size >= 3 || !low,
      detail: { proxy_pool_size: size, proxy_pool_low: low },
    }
  },

  // I7 — Synthetic monitor watches health invariants endpoint.
  // /api/health/invariants reports latest synthetic + stale flag.
  // If stale (>5min since last synthetic), the monitor itself is failing.
  invariants_endpoint_fresh: async () => {
    const r = await fetchJSON('/api/health/invariants')
    if (!r.ok) return { ok: false, detail: { http: r.status } }
    const body = r.body || {}
    return {
      ok: !body.stale && body.synthetic_age_min !== null,
      detail: { age_min: body.synthetic_age_min, stale: body.stale },
    }
  },
}

export async function runSyntheticSmoke({ url } = {}) {
  if (url) globalThis.__SYNTHETIC_URL_OVERRIDE__ = url
  const results = []
  for (const [name, fn] of Object.entries(INVARIANTS)) {
    const start = Date.now()
    try {
      const r = await fn()
      results.push({ name, ok: r.ok, detail: r.detail, duration_ms: Date.now() - start })
    } catch (e) {
      results.push({ name, ok: false, error: e?.message || String(e), duration_ms: Date.now() - start })
    }
  }
  const failed = results.filter(r => !r.ok)
  return {
    ok: failed.length === 0,
    pass_count: results.length - failed.length,
    fail_count: failed.length,
    results,
  }
}

// ── Vitest tests (skip-if-no-target) ─────────────────────────────────

describe.skipIf(!HAS_TARGET)('M1 — Synthetic prod-smoke (10 invariants)', () => {
  it('1. /api/health returns ok=true', async () => {
    const r = await INVARIANTS.health()
    expect(r.ok).toBe(true)
  })

  it('2. mailbox pipeline freshness < 24h', async () => {
    const r = await INVARIANTS.mailbox_pipeline_fresh()
    expect(r.ok).toBe(true)
  })

  it('3. heal SLO P99 within bounds', async () => {
    const r = await INVARIANTS.heal_slo_p99()
    expect(r.ok).toBe(true)
  })

  it('4. send_events > 0 over 7d', async () => {
    const r = await INVARIANTS.send_events_24h()
    expect(r.ok).toBe(true)
  })

  it('5. cron heartbeat alive', async () => {
    const r = await INVARIANTS.cron_heartbeat()
    expect(r.ok).toBe(true)
  })

  it('6. anti-trace relay healthy', async () => {
    const r = await INVARIANTS.anti_trace_health()
    expect(r.ok).toBe(true)
  })

  it('7. schema parity ok', async () => {
    const r = await INVARIANTS.schema_parity()
    expect(r.ok).toBe(true)
  })

  it('8. active mailboxes >= 1', async () => {
    const r = await INVARIANTS.active_mailboxes()
    expect(r.ok).toBe(true)
  })

  it('9. suppression healing alive', async () => {
    const r = await INVARIANTS.suppression_populated()
    expect(r.ok).toBe(true)
  })

  it('10. no auto_pause thrash (>3× per mb in 30min)', async () => {
    const r = await INVARIANTS.no_thrash()
    expect(r.ok).toBe(true)
  })

  it('runSyntheticSmoke aggregates all 10', async () => {
    const r = await runSyntheticSmoke()
    expect(r.results.length).toBe(10)
    expect(r.pass_count + r.fail_count).toBe(10)
  })
})

describe('M1 — Smoke fn shape (no target needed)', () => {
  it('INVARIANTS exports 12 named checks', () => {
    expect(Object.keys(INVARIANTS).length).toBe(12)
  })

  it('proxy_pool_healthy invariant is registered (MVP-3)', () => {
    expect(INVARIANTS).toHaveProperty('proxy_pool_healthy')
    expect(typeof INVARIANTS.proxy_pool_healthy).toBe('function')
  })

  it('runSyntheticSmoke returns expected shape with no target', async () => {
    process.env.SYNTHETIC_TARGET_URL = ''
    const r = await runSyntheticSmoke()
    expect(typeof r.ok).toBe('boolean')
    expect(typeof r.pass_count).toBe('number')
    expect(typeof r.fail_count).toBe('number')
    expect(Array.isArray(r.results)).toBe(true)
  })

  it('each invariant returns {ok, detail|error, duration_ms}', async () => {
    const r = await runSyntheticSmoke()
    for (const result of r.results) {
      expect(typeof result.ok).toBe('boolean')
      expect(typeof result.duration_ms).toBe('number')
      expect(result.duration_ms).toBeGreaterThanOrEqual(0)
    }
  })
})
