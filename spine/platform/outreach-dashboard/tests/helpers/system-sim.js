// system-sim.js — Multi-entity 7-day chaos simulator.
//
// Wires the existing chaos-sim.js MarkovSim/FaultInjector/FakeClock together
// with heal-fixtures (mailbox/cron/engine) and the heal-* libraries
// (cascade, backoff, escalation, budget, coordinator, counterfactual). The
// goal is to simulate a full week of system operation with realistic fault
// rates and observe that:
//
//   • All entities end the week in a healthy state.
//   • Recovery time histograms remain inside SLO bounds.
//   • The heal budget is never exhausted.
//   • Escalation only fires under sustained / thrashing fault patterns.
//
// Pure JS, no I/O. Determinism via seeded mulberry32 RNG inside FaultInjector.

import { FaultInjector, FakeClock } from './chaos-sim.js'
import { makeMockMailbox, makeMockCron, makeMockEngine } from './heal-fixtures.js'
import {
  buildDependencyDAG,
  cascadeFailure,
  cascadeRecovery,
} from '../../src/lib/heal-cascade.js'
import { computeNextCooldown, COOLDOWN_SCHEDULE_MS } from '../../src/lib/heal-backoff.js'
import { detectEscalation } from '../../src/lib/heal-escalation.js'
import { HealBudget } from '../../src/lib/heal-budget.js'
import { HealCoordinator } from '../../src/lib/heal-coordinator.js'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

// Fault names (string constants — keep in sync with realistic-rate fixtures).
export const FAULTS = Object.freeze({
  SMTP_FAIL:      'smtp_fail',         // 1 per 100 sends
  PROXY_EMPTY:    'proxy_empty',       // 1 per 24h
  ENGINE_PANIC:   'engine_panic',      // 1 per 7d
  DB_BLIP:        'db_blip',           // 1 per 12h
  ANTITRACE_503:  'antitrace_503',     // 1 per 6h
  CRON_STALL:     'cron_stall',        // 1 per 12h
  MAILBOX_DARK:   'mailbox_darkening', // 1 per 24h
})

/**
 * Realistic per-week fault rate fixture. Mirrors the "realistic fault rates"
 * section in HX3 task spec (and the system-report.mjs upper bounds).
 *
 * @param {FaultInjector} fi
 */
export function applyRealisticFaultRates(fi) {
  fi.add({ name: FAULTS.SMTP_FAIL,     rate_per_n: 100,  effect: 'increment_consecutive_bounces' })
  fi.add({ name: FAULTS.PROXY_EMPTY,   rate_per_d: 1,    effect: 'pool_zero' })
  fi.add({ name: FAULTS.ENGINE_PANIC,  rate_per_d: 1 / 7, effect: 'restart' })
  fi.add({ name: FAULTS.DB_BLIP,       rate_per_h: 1 / 12, effect: 'db_unavail' })
  fi.add({ name: FAULTS.ANTITRACE_503, rate_per_h: 1 / 6,  effect: 'relay_down' })
  fi.add({ name: FAULTS.CRON_STALL,    rate_per_h: 1 / 12, effect: 'cron_block' })
  fi.add({ name: FAULTS.MAILBOX_DARK,  rate_per_d: 1,    effect: 'darkening' })
}

/**
 * Multiply every existing fault's rate by `factor` (creates a new injector
 * pre-loaded with realistic rates × factor). Used by worst-case tests.
 *
 * @param {number} factor
 * @param {{seed?: number}} [opts]
 * @returns {FaultInjector}
 */
export function makeFaultInjectorScaled(factor, opts = {}) {
  const fi = new FaultInjector(opts)
  fi.add({ name: FAULTS.SMTP_FAIL,     rate_per_n: Math.max(1, Math.round(100 / factor)), effect: 'inc' })
  fi.add({ name: FAULTS.PROXY_EMPTY,   rate_per_d: 1 * factor, effect: 'pool_zero' })
  fi.add({ name: FAULTS.ENGINE_PANIC,  rate_per_d: (1 / 7) * factor, effect: 'restart' })
  fi.add({ name: FAULTS.DB_BLIP,       rate_per_h: (1 / 12) * factor, effect: 'db_unavail' })
  fi.add({ name: FAULTS.ANTITRACE_503, rate_per_h: (1 / 6) * factor, effect: 'relay_down' })
  fi.add({ name: FAULTS.CRON_STALL,    rate_per_h: (1 / 12) * factor, effect: 'cron_block' })
  fi.add({ name: FAULTS.MAILBOX_DARK,  rate_per_d: 1 * factor, effect: 'darkening' })
  return fi
}

/**
 * Build the production-shape dependency DAG used by chaos sims.
 * anti_trace → relay → sender → bff_cron → reporter
 */
export function buildSystemDAG() {
  return buildDependencyDAG([
    ['relay', 'anti_trace'],
    ['sender', 'relay'],
    ['bff_cron', 'sender'],
    ['reporter', 'bff_cron'],
  ])
}

/**
 * Construct a fresh multi-entity world: 5 mailboxes, 1 sender engine, 5
 * BFF crons, 1 anti-trace relay, 1 proxy pool. Entities are interconnected
 * via a mutable `deps` object so cascading failures can be modeled.
 *
 * @param {{fakeNow?: () => Date, mailboxCount?: number, cronCount?: number}} [opts]
 */
export function buildSystemFixture(opts = {}) {
  const fakeNow = typeof opts.fakeNow === 'function' ? opts.fakeNow : () => new Date()
  const mailboxCount = Number.isInteger(opts.mailboxCount) ? opts.mailboxCount : 5
  const cronCount = Number.isInteger(opts.cronCount) ? opts.cronCount : 5

  const mailboxes = []
  for (let i = 1; i <= mailboxCount; i += 1) {
    mailboxes.push(makeMockMailbox({ id: i, fakeNow }))
  }
  const engine = makeMockEngine({ mailboxes, fakeNow })
  const crons = []
  for (let i = 0; i < cronCount; i += 1) {
    crons.push(makeMockCron({ name: `cron-${i + 1}`, fakeNow }))
  }
  const antiTrace = {
    status: 'ok', // 'ok' | 'down'
    consecutive_503: 0,
    downSince: null,
  }
  const proxyPool = {
    status: 'ok', // 'ok' | 'critical'
    consecutive_zero_refresh: 0,
    last_pool_size: 100,
  }

  return { mailboxes, engine, crons, antiTrace, proxyPool }
}

/**
 * Run the multi-entity 7-day simulation. Realistic fault rates are applied
 * unless `opts.faultInjector` is supplied. The simulator advances in
 * `tick_ms = duration_ms / iterations` slices and applies every queued
 * fault to the matching entities.
 *
 * @param {object} opts
 * @param {number} [opts.seed=0]
 * @param {number} [opts.duration_ms=7 * DAY_MS]
 * @param {number} [opts.iterations=1000]
 * @param {number} [opts.mailboxCount=5]
 * @param {number} [opts.cronCount=5]
 * @param {number} [opts.faultRateMultiplier=1]
 * @param {boolean} [opts.disableHealing=false]
 * @returns {SystemSimResult}
 */
export function runSystemSim(opts = {}) {
  const seed = opts.seed ?? 0
  const duration_ms = opts.duration_ms ?? 7 * DAY_MS
  const iterations = opts.iterations ?? 1000
  const tick_ms = Math.max(1, Math.floor(duration_ms / iterations))
  const disableHealing = opts.disableHealing === true

  const clock = new FakeClock('2026-04-26T08:00:00Z')
  const fakeNow = () => clock.now()

  // Multi-entity world.
  const fixture = buildSystemFixture({
    fakeNow,
    mailboxCount: opts.mailboxCount,
    cronCount: opts.cronCount,
  })

  // Fault generator. If a custom injector is supplied, use it as-is.
  const fi = opts.faultInjector
    ? opts.faultInjector
    : (() => {
        const inst = new FaultInjector({ seed })
        const factor = opts.faultRateMultiplier ?? 1
        if (factor === 1) applyRealisticFaultRates(inst)
        else {
          // Build scaled rates manually (keep ordering identical to realistic).
          inst.add({ name: FAULTS.SMTP_FAIL,     rate_per_n: Math.max(1, Math.round(100 / factor)), effect: 'inc' })
          inst.add({ name: FAULTS.PROXY_EMPTY,   rate_per_d: 1 * factor, effect: 'pool_zero' })
          inst.add({ name: FAULTS.ENGINE_PANIC,  rate_per_d: (1 / 7) * factor, effect: 'restart' })
          inst.add({ name: FAULTS.DB_BLIP,       rate_per_h: (1 / 12) * factor, effect: 'db_unavail' })
          inst.add({ name: FAULTS.ANTITRACE_503, rate_per_h: (1 / 6) * factor, effect: 'relay_down' })
          inst.add({ name: FAULTS.CRON_STALL,    rate_per_h: (1 / 12) * factor, effect: 'cron_block' })
          inst.add({ name: FAULTS.MAILBOX_DARK,  rate_per_d: 1 * factor, effect: 'darkening' })
        }
        return inst
      })()

  // Heal infrastructure.
  const budget = new HealBudget({
    perEntityHourly: 30,
    systemHourly: 1000,
    now: () => clock.now().getTime(),
  })
  const throttled = []
  budget.onThrottle = (info) => throttled.push(info)
  const coordinator = new HealCoordinator()
  const dag = buildSystemDAG()

  // Per-entity backoff history & escalation tracking.
  /** @type {Map<string, Array<{pause_at: number, resume_at: number, refailed: boolean}>>} */
  const backoffHistory = new Map()
  /** @type {Set<string>} */
  const escalatedEntities = new Set()

  // Per-entity 24h rolling state-visit window for anti-thrash invariant.
  /** @type {Map<string, Array<{at: number, status: string}>>} */
  const statusWindows = new Map()

  // Aggregated metrics + heal-event log.
  const heal_events = []
  const recoveryTimes = {
    mailbox: [], // ms from pause → active resume
    cron: [],    // ms from error → next successful tick
    engine: [],  // ms from panic → supervisor restart
    antiTrace: [], // ms from down → ok
  }
  // Per-entity outstanding pause/error timestamps.
  const openPauses = new Map() // key=entity-id, value=pause_at_ms
  const openErrors = new Map()
  // Suppression list — bounce-cascade fixture.
  const suppressions = new Set() // emails

  // Auth cache fixture (HX6) — auth probes within TTL skip; outside re-probe.
  const AUTH_CACHE_TTL_MS = 30 * 60 * 1000
  const authCache = new Map() // mailboxId → lastProbeAt

  // Counterfactual: track per-entity send_events (proxy for "operability").
  let sendEvents = 0
  let shadowSendEvents = 0 // hypothetical "no heal" parallel run

  // Tracks the "needs_human" flag — flipped on if escalation triggers.
  let needsHuman = false

  // ─────────────────────────────────────────────────────────────────────
  // Helpers — fault application logic.
  // ─────────────────────────────────────────────────────────────────────

  function nowMs() {
    return clock.now().getTime()
  }

  function recordStatusWindow(entityKey, status) {
    let win = statusWindows.get(entityKey)
    if (!win) {
      win = []
      statusWindows.set(entityKey, win)
    }
    const t = nowMs()
    win.push({ at: t, status })
    // Drop entries older than 24h.
    const cutoff = t - DAY_MS
    while (win.length > 0 && win[0].at < cutoff) win.shift()
  }

  function pushHeal(name, detail) {
    heal_events.push({
      name,
      at: nowMs(),
      iso: clock.now().toISOString(),
      ...detail,
    })
  }

  function addBackoffCycle(entityKey, refailed) {
    let arr = backoffHistory.get(entityKey)
    if (!arr) {
      arr = []
      backoffHistory.set(entityKey, arr)
    }
    // resume_at is provisional — recoverEntities updates it once the
    // cooldown actually expires.
    arr.push({
      pause_at: nowMs(),
      resume_at: nowMs(),
      refailed,
    })
  }

  function checkEscalation(entityKey) {
    const hist = backoffHistory.get(entityKey) || []
    const result = detectEscalation(hist, nowMs())
    if (result.escalate) {
      escalatedEntities.add(entityKey)
      needsHuman = true
      pushHeal('escalation', { entity: entityKey, reason: result.reason })
    }
  }

  function applySmtpFail() {
    // Pick a mailbox round-robin by event count.
    const mb = fixture.mailboxes[heal_events.length % fixture.mailboxes.length]
    if (!mb || mb.status !== 'active') return
    // Budget gate (only relevant when healing is enabled).
    if (!disableHealing) {
      const allowed = budget.allow(`mailbox-${mb.id}`, 1)
      if (!allowed) return
    }
    mb.recordSmtpFailure({ code: '535', detail: 'auth invalid' })
    if (mb.consecutive_bounces >= 3 && mb.status === 'active') {
      // Coordinator: only one healer can pause at a time.
      const acq = coordinator.tryAcquire(`mailbox-${mb.id}`, `sim-${mb.id}`, nowMs())
      if (acq.acquired) {
        try {
          mb.simulateAutoPause()
          openPauses.set(`mailbox-${mb.id}`, nowMs())
          // suppression record.
          suppressions.add(mb.email)
          addBackoffCycle(`mailbox-${mb.id}`, false)
          pushHeal('mailbox_pause', { entity: `mailbox-${mb.id}` })
          recordStatusWindow(`mailbox-${mb.id}`, 'paused')
        } finally {
          coordinator.release(`mailbox-${mb.id}`, `sim-${mb.id}`)
        }
      }
    }
  }

  function applyMailboxDark() {
    // Roll one specific mailbox into "darkened" status (paused).
    const idx = Math.floor((heal_events.length * 7) % fixture.mailboxes.length)
    const mb = fixture.mailboxes[idx]
    if (!mb || mb.status !== 'active') return
    if (!disableHealing && !budget.allow(`mailbox-${mb.id}`, 1)) return
    mb.consecutive_bounces = 3
    mb.simulateAutoPause()
    openPauses.set(`mailbox-${mb.id}`, nowMs())
    addBackoffCycle(`mailbox-${mb.id}`, true)
    pushHeal('mailbox_pause', { entity: `mailbox-${mb.id}`, cause: 'darkening' })
    recordStatusWindow(`mailbox-${mb.id}`, 'paused')
    checkEscalation(`mailbox-${mb.id}`)
  }

  function applyEnginePanic() {
    fixture.engine.injectPanic()
    openErrors.set('engine', nowMs())
    pushHeal('engine_panic', { entity: 'engine' })
    // Supervisor restart simulated 1 tick later via recoverEntities.
  }

  function applyAntiTrace503() {
    fixture.antiTrace.consecutive_503 += 1
    if (fixture.antiTrace.status === 'ok') {
      fixture.antiTrace.status = 'down'
      fixture.antiTrace.downSince = nowMs()
      openErrors.set('antiTrace', nowMs())
      pushHeal('antitrace_down', { entity: 'antiTrace' })
      // Cascade: sender depends on relay (which depends on antiTrace) — so
      // pause the engine logically until antiTrace recovers.
      fixture.engine.health = { ...fixture.engine.health, status: 'stale' }
    }
  }

  function applyDbBlip() {
    // DB blip: marks all crons unhealthy briefly, but cron-guard recovers.
    for (const cron of fixture.crons) {
      cron.injectError(new Error('db_blip'))
      cron.tick()
      openErrors.set(`cron-${cron.name}`, nowMs())
    }
    pushHeal('db_blip', { entity: 'db' })
  }

  function applyCronStall() {
    // One cron stalls — modelled as injectError that the cron-guard catches.
    const idx = Math.floor((heal_events.length * 11) % fixture.crons.length)
    const cron = fixture.crons[idx]
    if (!cron) return
    cron.injectError(new Error('stall'))
    cron.tick()
    openErrors.set(`cron-${cron.name}`, nowMs())
    pushHeal('cron_stall', { entity: `cron-${cron.name}` })
  }

  function applyProxyEmpty() {
    fixture.proxyPool.consecutive_zero_refresh += 1
    fixture.proxyPool.last_pool_size = 0
    if (fixture.proxyPool.consecutive_zero_refresh >= 3) {
      if (fixture.proxyPool.status !== 'critical') {
        fixture.proxyPool.status = 'critical'
        // Only set openErrors first time entering critical — re-entries don't
        // restart the recovery clock.
        if (!openErrors.has('proxyPool')) {
          openErrors.set('proxyPool', nowMs())
        }
        pushHeal('proxy_critical', { entity: 'proxyPool' })
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Per-tick recovery sweep.
  // ─────────────────────────────────────────────────────────────────────

  function recoverEntities(now) {
    // Mailboxes — cooldown via heal-backoff.computeNextCooldown.
    for (const mb of fixture.mailboxes) {
      if (mb.status !== 'paused') continue
      const key = `mailbox-${mb.id}`
      if (escalatedEntities.has(key)) continue
      const hist = backoffHistory.get(key) || []
      const { cooldown_ms, escalate } = computeNextCooldown(hist, now)
      // If the cooldown schedule itself has been exhausted (step ≥5), surface
      // needs_human and skip auto-recovery — operator must clear manually.
      if (escalate) {
        escalatedEntities.add(key)
        needsHuman = true
        pushHeal('escalation', { entity: key, reason: 'schedule_exhausted' })
        continue
      }
      const pausedAt = openPauses.get(key)
      if (pausedAt !== undefined && now - pausedAt >= cooldown_ms) {
        mb.simulateCooldownExpiry()
        const recoveryDuration = now - pausedAt
        recoveryTimes.mailbox.push(recoveryDuration)
        openPauses.delete(key)
        pushHeal('mailbox_resume', { entity: key, duration_ms: recoveryDuration })
        recordStatusWindow(key, 'active')
        // Update resume_at on the most recent cycle so the backoff schedule
        // reset window can compute correctly.
        const latest = hist[hist.length - 1]
        if (latest) latest.resume_at = now
      }
    }
    // Crons — single-tick recovery (next tick clears injected error).
    for (const cron of fixture.crons) {
      const key = `cron-${cron.name}`
      const erroredAt = openErrors.get(key)
      const hb = cron.heartbeat()
      if (erroredAt !== undefined && hb.consecutiveErrors > 0) {
        // After 1 tick, run a clean cycle.
        cron.tick()
        const hb2 = cron.heartbeat()
        if (hb2.consecutiveErrors === 0) {
          const dur = now - erroredAt
          recoveryTimes.cron.push(dur)
          openErrors.delete(key)
          pushHeal('cron_resume', { entity: key, duration_ms: dur })
        }
      }
    }
    // Engine — supervisor restart 1 tick after panic.
    const enginePanicAt = openErrors.get('engine')
    if (enginePanicAt !== undefined && fixture.engine.breakerOpen) {
      fixture.engine.supervisorRestart()
      const dur = now - enginePanicAt
      recoveryTimes.engine.push(dur)
      openErrors.delete('engine')
      pushHeal('engine_restart', { entity: 'engine', duration_ms: dur })
    }
    // Anti-trace — recovers after 1 tick once the 503 burst stops.
    const atDownAt = openErrors.get('antiTrace')
    if (atDownAt !== undefined) {
      // Heuristic: clear after 2 ticks.
      if (now - atDownAt >= tick_ms * 2) {
        fixture.antiTrace.status = 'ok'
        fixture.antiTrace.consecutive_503 = 0
        fixture.antiTrace.downSince = null
        const dur = now - atDownAt
        recoveryTimes.antiTrace.push(dur)
        openErrors.delete('antiTrace')
        fixture.engine.health = { ...fixture.engine.health, status: 'ok' }
        pushHeal('antitrace_resume', { entity: 'antiTrace', duration_ms: dur })
      }
    }
    // Proxy pool — first non-zero refresh after critical clears state.
    const ppDownAt = openErrors.get('proxyPool')
    if (ppDownAt !== undefined && now - ppDownAt >= tick_ms * 2) {
      fixture.proxyPool.status = 'ok'
      fixture.proxyPool.consecutive_zero_refresh = 0
      fixture.proxyPool.last_pool_size = 100
      openErrors.delete('proxyPool')
      pushHeal('proxy_resume', { entity: 'proxyPool', duration_ms: now - ppDownAt })
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Run loop.
  // ─────────────────────────────────────────────────────────────────────

  for (let i = 0; i < iterations; i += 1) {
    clock.advance(tick_ms)
    const now = nowMs()

    // 1. Drain time-based and event-based faults (multiple per tick allowed).
    const fEvent = fi.nextEvent()
    if (fEvent) dispatchFault(fEvent)
    const fTime = fi.next(tick_ms)
    if (fTime) dispatchFault(fTime)

    // 2. Engine activity proxy: count send events when engine ok and ≥1 mailbox active.
    if (fixture.engine.health.status === 'ok') {
      const activeCount = fixture.mailboxes.filter((mb) => mb.status === 'active').length
      sendEvents += activeCount
    }

    // 3. Recovery sweep (skipped in disableHealing/shadow runs — that's the
    //    counterfactual: faults still apply but no heal action runs).
    if (!disableHealing) recoverEntities(now)
  }

  function dispatchFault(fault) {
    switch (fault.name) {
      case FAULTS.SMTP_FAIL: applySmtpFail(); break
      case FAULTS.MAILBOX_DARK: applyMailboxDark(); break
      case FAULTS.ENGINE_PANIC: applyEnginePanic(); break
      case FAULTS.ANTITRACE_503: applyAntiTrace503(); break
      case FAULTS.DB_BLIP: applyDbBlip(); break
      case FAULTS.CRON_STALL: applyCronStall(); break
      case FAULTS.PROXY_EMPTY: applyProxyEmpty(); break
      default: break
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Final summary.
  // ─────────────────────────────────────────────────────────────────────

  const unrecovered = countUnrecovered(fixture)

  return {
    fixture,
    heal_events,
    recoveryTimes,
    throttled,
    suppressions: [...suppressions],
    statusWindows,
    backoffHistory,
    escalatedEntities: [...escalatedEntities],
    needsHuman,
    sendEvents,
    shadowSendEvents,
    unrecovered,
    iterations,
    tick_ms,
    duration_ms,
    seed,
    authCache, // exposed so HX6 cache-TTL test can poke at it
  }
}

/**
 * @param {ReturnType<typeof buildSystemFixture>} fixture
 */
export function countUnrecovered(fixture) {
  let n = 0
  for (const mb of fixture.mailboxes) if (mb.status !== 'active') n += 1
  if (fixture.engine.breakerOpen) n += 1
  if (fixture.engine.health.status === 'down') n += 1
  if (fixture.antiTrace.status !== 'ok') n += 1
  if (fixture.proxyPool.status !== 'ok') n += 1
  return n
}

/**
 * @typedef {object} SystemSimResult
 * @property {ReturnType<typeof buildSystemFixture>} fixture
 * @property {Array<{name: string, at: number, iso: string, [k: string]: any}>} heal_events
 * @property {{mailbox: number[], cron: number[], engine: number[], antiTrace: number[]}} recoveryTimes
 * @property {Array<object>} throttled
 * @property {string[]} suppressions
 * @property {Map<string, Array<{at: number, status: string}>>} statusWindows
 * @property {Map<string, Array<{pause_at: number, resume_at: number, refailed: boolean}>>} backoffHistory
 * @property {string[]} escalatedEntities
 * @property {boolean} needsHuman
 * @property {number} sendEvents
 * @property {number} shadowSendEvents
 * @property {number} unrecovered
 * @property {number} iterations
 * @property {number} tick_ms
 * @property {number} duration_ms
 * @property {number} seed
 * @property {Map<number, number>} authCache
 */
