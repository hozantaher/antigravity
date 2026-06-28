// Config drift detector. Runs on boot + every 5 min. Surfaces hidden
// mismatches (duplicate vite configs, bad GO_SERVER_URL, empty pool,
// stale watchdog) to /api/health/drift so UI can render a banner and
// operator catches problems before they translate into send failures.
//
// Severity levels: 'critical' → UI banner, 'warn' → logged, 'info' → silent.

import { existsSync, readFileSync } from 'fs'
import path from 'path'

const MIN = 60_000

function runCheck(name, severity, fn) {
  return { name, severity, fn }
}

// Each check returns { ok, detail } or { ok: false, message }.
const CHECKS = [
  runCheck('vite_duplicate_configs', 'warn', async () => {
    const dir = path.resolve(process.cwd(), 'apps/outreach-dashboard')
    const root = existsSync(path.join(dir, 'vite.config.js')) ? dir : process.cwd()
    const hasJs = existsSync(path.join(root, 'vite.config.js'))
    const hasTs = existsSync(path.join(root, 'vite.config.ts'))
    if (hasJs && hasTs) {
      return { ok: false, message: 'both vite.config.js and vite.config.ts exist — Vite picks one, ambiguous source of truth' }
    }
    return { ok: true, detail: `found: ${hasJs ? 'js' : ''}${hasTs ? 'ts' : ''}` }
  }),

  runCheck('vite_proxy_port_mismatch', 'critical', async () => {
    const dir = path.resolve(process.cwd(), 'apps/outreach-dashboard')
    const root = existsSync(path.join(dir, 'vite.config.js')) ? dir : process.cwd()
    const configs = ['vite.config.js', 'vite.config.ts']
      .map(f => path.join(root, f))
      .filter(p => existsSync(p))
    const bffPort = Number(process.env.PORT || 18001)
    const found = []
    for (const p of configs) {
      const txt = readFileSync(p, 'utf8')
      // Match only proxy targets, not jsdom URLs / server.port / other localhost refs.
      const m = txt.match(/(?:target|proxy)[^\n]*?localhost:(\d+)/gi) || []
      for (const hit of m) {
        const port = Number(hit.match(/localhost:(\d+)/)[1])
        if (port !== bffPort) found.push(`${path.basename(p)}: ${port}`)
      }
    }
    if (found.length) return { ok: false, message: `vite proxy points to wrong port (BFF=${bffPort}): ${found.join(', ')}` }
    return { ok: true, detail: `bff_port=${bffPort}` }
  }),

  runCheck('backend_unreachable', 'warn', async (ctx) => {
    const url = process.env.GO_SERVER_URL
    if (!url) return { ok: true, detail: 'no_go_backend_configured' }
    try {
      const r = await fetch(url + '/health', { signal: AbortSignal.timeout(2000) })
      if (!r.ok) return { ok: false, message: `${url}/health → ${r.status}` }
      return { ok: true, detail: `reachable` }
    } catch (e) {
      return { ok: false, message: `${url}: ${e.message}` }
    }
  }),

  runCheck('anti_trace_misconfigured', 'info', async (ctx) => {
    const { rows } = await ctx.pool.query(`SELECT value FROM outreach_config WHERE key='anti_trace_url'`)
    const url = rows[0]?.value
    if (!url) return { ok: true, detail: 'not_configured' }
    try {
      const r = await fetch(url + '/healthz', { signal: AbortSignal.timeout(3000) })
      if (!r.ok) return { ok: false, message: `anti_trace_url set but ${r.status}` }
      return { ok: true, detail: 'reachable' }
    } catch (e) {
      return { ok: false, message: `anti_trace_url set but unreachable: ${e.message}` }
    }
  }),

  runCheck('proxy_pool_low', 'critical', async (ctx) => {
    const cache = ctx.getProxyCache?.()
    const n = cache?.working?.length || 0
    // Mullvad-only deployments don't run a rotating pool; the relay's
    // /v1/proxy-pool legitimately returns zero working entries. Skip the
    // critical alert in that mode and rely on probe-level checks instead.
    if (cache && cache.mode === 'mullvad') return { ok: true, detail: 'mullvad_mode' }
    if (cache?.last_refresh == null && n === 0) return { ok: true, detail: 'pool_not_configured' }
    if (n < 3) return { ok: false, message: `pool has ${n} working proxies (<3 blocks sending)` }
    if (n < 5) return { ok: true, detail: `pool_size=${n} (low but usable)` }
    return { ok: true, detail: `pool_size=${n}` }
  }),

  runCheck('watchdog_stale', 'warn', async (ctx) => {
    const { rows } = await ctx.pool.query(
      `SELECT created_at FROM watchdog_events ORDER BY created_at DESC LIMIT 1`
    )
    if (!rows.length) return { ok: false, message: 'no watchdog_events ever' }
    const age = Date.now() - new Date(rows[0].created_at).getTime()
    if (age > 10 * MIN) return { ok: false, message: `last event ${Math.round(age / MIN)}min ago` }
    return { ok: true, detail: `age_${Math.round(age / MIN)}min` }
  }),
]

export async function runConfigDrift(ctx) {
  const drifts = []
  for (const c of CHECKS) {
    try {
      const r = await c.fn(ctx)
      if (!r.ok) {
        drifts.push({
          check: c.name,
          severity: c.severity,
          message: r.message || 'drift detected',
          detected_at: new Date().toISOString(),
        })
      }
    } catch (err) {
      drifts.push({
        check: c.name,
        severity: 'warn',
        message: `check failed: ${err.message}`,
        detected_at: new Date().toISOString(),
      })
    }
  }
  const critical = drifts.filter(d => d.severity === 'critical')
  return {
    ok: critical.length === 0,
    drifts,
    critical_count: critical.length,
    checked_at: new Date().toISOString(),
  }
}
