// Stale-state detector + auto-recovery.
// Runs on BFF boot (catch-up) and every 60s. Each guard is independent
// (one failure does not block others). All recovery actions are logged
// into watchdog_events with auto_healed=true.
//
// Contract per guard:
//   name, ttlMs, severity: 'info' | 'warn' | 'crit',
//   check(ctx)   → { stale: boolean, lastAt: Date|null, reason?: string, skip?: boolean }
//   recover(ctx) → { ok: boolean, message: string }
//
// ctx = { pool, triggers: { refreshProxyPool, runWarmupAdvanceCron, runPipelineTest, getProxyCache, pingAntiTrace } }

const MIN = 60_000

export const GUARDS = [
  {
    name: 'proxy_pool',
    ttlMs: 30 * MIN,
    severity: 'warn',
    async check(ctx) {
      const cache = ctx.triggers.getProxyCache?.()
      if (!cache) return { stale: true, lastAt: null, reason: 'no_cache' }
      const lastAt = cache.cached_at ? new Date(cache.cached_at) : null
      const empty = !cache.working || cache.working.length === 0
      const age = lastAt ? Date.now() - lastAt.getTime() : Infinity
      return { stale: empty || age > this.ttlMs, lastAt, reason: empty ? 'empty_pool' : `age_${Math.round(age / MIN)}min` }
    },
    async recover(ctx) {
      const data = await ctx.triggers.refreshProxyPool()
      const n = data?.working?.length ?? 0
      return { ok: n > 0, message: `refreshed proxy pool → ${n} working` }
    },
  },

  {
    name: 'watchdog_heartbeat',
    ttlMs: 10 * MIN,
    severity: 'warn',
    async check(ctx) {
      const { rows } = await ctx.pool.query(
        `SELECT created_at FROM watchdog_events ORDER BY created_at DESC LIMIT 1`
      )
      const lastAt = rows[0]?.created_at ? new Date(rows[0].created_at) : null
      const age = lastAt ? Date.now() - lastAt.getTime() : Infinity
      return { stale: age > this.ttlMs, lastAt, reason: lastAt ? `age_${Math.round(age / MIN)}min` : 'no_events' }
    },
    async recover(ctx) {
      await ctx.pool.query(
        `INSERT INTO watchdog_events (check_name, severity, message, auto_healed)
         VALUES ('bff_heartbeat', 'info', 'BFF alive (stale-guard recovery)', true)`
      )
      return { ok: true, message: 'inserted heartbeat' }
    },
  },

  {
    name: 'anti_trace',
    ttlMs: 5 * MIN,
    severity: 'info',
    async check(ctx) {
      const { rows } = await ctx.pool.query(`SELECT value FROM outreach_config WHERE key='anti_trace_url'`)
      const url = rows[0]?.value
      if (!url) return { stale: false, lastAt: null, skip: true, reason: 'not_configured' }
      // Last successful probe stored in memory on ctx.triggers (optional). Without it we treat as always stale.
      const lastAt = ctx.triggers.lastAntiTraceOk?.() ?? null
      const age = lastAt ? Date.now() - lastAt.getTime() : Infinity
      return { stale: age > this.ttlMs, lastAt, reason: lastAt ? `age_${Math.round(age / MIN)}min` : 'never_probed' }
    },
    async recover(ctx) {
      const result = await ctx.triggers.pingAntiTrace?.()
      if (!result) return { ok: false, message: 'no anti-trace pinger available' }
      return { ok: !!result.ok, message: result.ok ? `anti-trace ${result.ms}ms` : `anti-trace failed: ${result.reason || 'unknown'}` }
    },
  },

  {
    name: 'warmup_advance',
    ttlMs: 26 * 60 * MIN,
    severity: 'warn',
    async check(ctx) {
      const { rows } = await ctx.pool.query(`
        SELECT MAX(w.last_advanced_at) AS last_at
        FROM mailbox_warmup w
        JOIN outreach_mailboxes m ON m.from_address = w.mailbox_address
        WHERE m.status='active' AND w.is_paused=false AND w.warmup_day IS NOT NULL
      `)
      const lastAt = rows[0]?.last_at ? new Date(rows[0].last_at) : null
      const age = lastAt ? Date.now() - lastAt.getTime() : Infinity
      return { stale: age > this.ttlMs, lastAt, reason: lastAt ? `age_${Math.round(age / (60 * MIN))}h` : 'no_warmups' }
    },
    async recover(ctx) {
      await ctx.triggers.runWarmupAdvanceCron()
      return { ok: true, message: 'ran warmup-advance cron' }
    },
  },

  {
    name: 'pipeline_results',
    ttlMs: 24 * 60 * MIN,
    severity: 'info',
    async check(ctx) {
      // If any active mailbox has no pipeline row in last 24h, mark stale (single mailbox trigger is enough — we'll fire for all).
      const { rows } = await ctx.pool.query(`
        SELECT m.id
        FROM outreach_mailboxes m
        LEFT JOIN LATERAL (
          SELECT tested_at FROM mailbox_pipeline_results r
          WHERE r.mailbox_id = m.id ORDER BY r.tested_at DESC LIMIT 1
        ) p ON true
        WHERE m.status='active'
          AND (p.tested_at IS NULL OR p.tested_at < now() - interval '24 hours')
        LIMIT 1
      `)
      const stale = rows.length > 0
      return { stale, lastAt: null, reason: stale ? `mailbox_${rows[0].id}_stale` : 'fresh' }
    },
    async recover(ctx) {
      const { rows } = await ctx.pool.query(`
        SELECT m.id
        FROM outreach_mailboxes m
        LEFT JOIN LATERAL (
          SELECT tested_at FROM mailbox_pipeline_results r
          WHERE r.mailbox_id = m.id ORDER BY r.tested_at DESC LIMIT 1
        ) p ON true
        WHERE m.status='active'
          AND (p.tested_at IS NULL OR p.tested_at < now() - interval '24 hours')
      `).catch(() => ({ rows: [] }))
      let fired = 0
      for (const row of rows.slice(0, 5)) {
        try { await ctx.triggers.runPipelineTest(row.id); fired++ } catch {}
      }
      return { ok: fired > 0, message: `pipeline-test fired on ${fired} mailbox(es)` }
    },
  },

  {
    name: 'mailbox_proxy',
    ttlMs: 15 * MIN,
    severity: 'info',
    async check(ctx) {
      const cache = ctx.triggers.getProxyCache?.()
      const working = new Set((cache?.working || []).map(p => p.addr))
      if (!working.size) return { stale: false, lastAt: null, skip: true, reason: 'no_pool' }
      const { rows } = await ctx.pool.query(`
        SELECT id, proxy_url FROM outreach_mailboxes
        WHERE status='active' AND proxy_url IS NOT NULL AND proxy_url <> ''
      `)
      const dead = rows.filter(r => {
        const addr = r.proxy_url.replace(/^socks5:\/\//, '').replace(/^http:\/\//, '').split('@').pop()
        return !working.has(addr)
      })
      return { stale: dead.length > 0, lastAt: null, reason: dead.length ? `${dead.length}_dead_proxies` : 'all_alive', dead }
    },
    async recover(ctx, result) {
      // Soft-log only; actual reassign happens via ProxyReassignGuard on error path.
      const dead = result?.dead || []
      if (!dead.length) return { ok: true, message: 'no dead proxies' }
      return { ok: true, message: `flagged ${dead.length} mailbox(es) with pool-missing proxy` }
    },
  },
]

export async function runGuards(ctx) {
  const results = []
  for (const g of GUARDS) {
    const started = Date.now()
    let status = 'ok', message = '', recovered = false, skipped = false
    let checkResult = null
    try {
      checkResult = await g.check(ctx)
      if (checkResult.skip) {
        status = 'skip'; skipped = true; message = checkResult.reason || ''
      } else if (checkResult.stale) {
        try {
          const rec = await g.recover(ctx, checkResult)
          recovered = !!rec.ok
          status = recovered ? 'recovered' : 'failed'
          message = rec.message || ''
          if (recovered) {
            await ctx.pool.query(
              `INSERT INTO watchdog_events (check_name, severity, message, auto_healed, healed_at)
               VALUES ($1, $2, $3, true, now())`,
              [`stale_guard:${g.name}`, g.severity, `${checkResult.reason || 'stale'} → ${message}`]
            ).catch(() => {})
          }
        } catch (err) {
          status = 'failed'; message = err.message
        }
      } else {
        status = 'fresh'; message = checkResult.reason || ''
      }
    } catch (err) {
      status = 'check_error'; message = err.message
    }
    results.push({
      name: g.name,
      status,
      stale: !!checkResult?.stale,
      recovered,
      skipped,
      message,
      elapsed_ms: Date.now() - started,
      last_at: checkResult?.lastAt || null,
    })
  }
  return results
}

export async function logBootRecovery(pool, results, meta) {
  try {
    await pool.query(
      `INSERT INTO bff_boot_log (started_at, git_sha, pid, guard_results)
       VALUES (now(), $1, $2, $3)`,
      [meta.gitSha || null, meta.pid || null, JSON.stringify(results)]
    )
  } catch {}
}
