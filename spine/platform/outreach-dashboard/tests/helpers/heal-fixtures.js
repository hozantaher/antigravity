// Self-healing fixtures shared across H / HX / HXX test tracks.
//
// Pure JS, no external deps. Deterministic — given the same calls and a
// fakeNow injection, the produced state is identical between runs.
//
// Production schema reference (server.js healing_log table):
//   { id, entity_type, entity_id, entity_label, action, reason,
//     resolved_at, created_at }
// All healing_log entries emitted here mirror that shape exactly.
//
// Mailbox passwords intentionally NOT modeled — production rule
// (memory: feedback_mailbox_passwords_via_db.md) keeps secrets in DB,
// fixtures must not introduce env-var or hard-coded password fields.

/**
 * Defensive deep-freeze. Recurses through plain objects and arrays.
 * Returns the same reference once frozen.
 *
 * @template T
 * @param {T} obj
 * @returns {Readonly<T>}
 */
function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') return obj
  if (Object.isFrozen(obj)) return obj
  for (const key of Object.keys(obj)) {
    const val = obj[key]
    if (val !== null && typeof val === 'object') deepFreeze(val)
  }
  return Object.freeze(obj)
}

/**
 * Default clock — overridable via `fakeNow` factory option for determinism.
 */
function defaultNow() {
  return new Date()
}

/**
 * Build a healing_log entry that matches the production schema 1:1.
 *
 * @param {object} args
 * @param {number} args.id          monotonic, fixture-local
 * @param {string} args.entity_type
 * @param {number} args.entity_id
 * @param {string|null} args.entity_label
 * @param {string} args.action
 * @param {string} args.reason
 * @param {Date}   args.now
 * @returns {object}
 */
function makeHealingEntry({ id, entity_type, entity_id, entity_label, action, reason, now }) {
  return {
    id,
    entity_type,
    entity_id,
    entity_label,
    action,
    reason,
    resolved_at: null,
    created_at: now.toISOString(),
  }
}

/**
 * @param {object} [opts]
 * @param {number} [opts.id]
 * @param {'active'|'paused'|'retired'} [opts.status]
 * @param {number} [opts.consecutive_bounces]
 * @param {number} [opts.daily_cap]
 * @param {string} [opts.email]
 * @param {() => Date} [opts.fakeNow]
 */
export function makeMockMailbox(opts = {}) {
  const fakeNow = typeof opts.fakeNow === 'function' ? opts.fakeNow : defaultNow

  // Internal monotonic id for healing_log entries owned by this mailbox.
  let nextLogId = 1
  const healingLog = []

  const mb = {
    id: opts.id ?? 1,
    email: opts.email ?? `mailbox-${opts.id ?? 1}@example.cz`,
    status: opts.status ?? 'active',
    consecutive_bounces: opts.consecutive_bounces ?? 0,
    daily_cap: opts.daily_cap ?? 100,
    healingLog,

    /**
     * Records an SMTP send failure. Increments the bounce counter and
     * appends a healing_log entry of action=smtp_failure.
     *
     * @param {{ code: string, detail?: string }} info
     */
    recordSmtpFailure(info = {}) {
      const code = info.code ?? 'unknown'
      const detail = info.detail ?? ''
      mb.consecutive_bounces += 1
      healingLog.push(
        makeHealingEntry({
          id: nextLogId++,
          entity_type: 'mailbox',
          entity_id: mb.id,
          entity_label: mb.email,
          action: 'smtp_failure',
          reason: `SMTP ${code}${detail ? `: ${detail}` : ''}`,
          now: fakeNow(),
        })
      )
    },

    /**
     * Marks the mailbox as auto-paused. Mirrors what the BFF does after
     * 3 consecutive SMTP failures.
     */
    simulateAutoPause() {
      mb.status = 'paused'
      healingLog.push(
        makeHealingEntry({
          id: nextLogId++,
          entity_type: 'mailbox',
          entity_id: mb.id,
          entity_label: mb.email,
          action: 'auto_pause',
          reason: `${mb.consecutive_bounces}× SMTP failure → auto pause`,
          now: fakeNow(),
        })
      )
    },

    /**
     * Cooldown elapsed — mailbox is automatically resumed and the
     * counter is reset. Resolves any open auto_pause entry.
     */
    simulateCooldownExpiry() {
      mb.status = 'active'
      mb.consecutive_bounces = 0
      const nowIso = fakeNow().toISOString()
      // Resolve last open auto_pause entry, if any.
      for (let i = healingLog.length - 1; i >= 0; i -= 1) {
        if (healingLog[i].action === 'auto_pause' && healingLog[i].resolved_at === null) {
          healingLog[i] = { ...healingLog[i], resolved_at: nowIso }
          break
        }
      }
      healingLog.push(
        makeHealingEntry({
          id: nextLogId++,
          entity_type: 'mailbox',
          entity_id: mb.id,
          entity_label: mb.email,
          action: 'cooldown_resume',
          reason: 'cooldown elapsed → auto resume',
          now: fakeNow(),
        })
      )
    },

    /**
     * Immutable point-in-time snapshot of the mailbox state.
     */
    snapshot() {
      return snapshotState(mb)
    },
  }

  return mb
}

/**
 * @param {object} [opts]
 * @param {string} [opts.name]
 * @param {number} [opts.interval_ms]
 * @param {() => void} [opts.callback]
 * @param {() => Date} [opts.fakeNow]
 */
export function makeMockCron(opts = {}) {
  const fakeNow = typeof opts.fakeNow === 'function' ? opts.fakeNow : defaultNow
  const callback = typeof opts.callback === 'function' ? opts.callback : () => {}

  let lastSuccessAt = null
  let lastErrorAt = null
  let consecutiveErrors = 0
  /** @type {Error|null} */
  let pendingError = null

  const cron = {
    name: opts.name ?? 'unnamed-cron',
    interval_ms: opts.interval_ms ?? 60_000,

    /**
     * Inject an error to be thrown by the next tick. The cron guard
     * recovers — the error is recorded, never re-thrown to the caller.
     */
    injectError(err) {
      pendingError = err instanceof Error ? err : new Error(String(err))
    },

    /**
     * Advance the cron by one tick. If an error was injected, the guard
     * captures it. Otherwise the callback runs and lastSuccessAt advances.
     */
    tick() {
      const nowIso = fakeNow().toISOString()
      if (pendingError) {
        lastErrorAt = nowIso
        consecutiveErrors += 1
        pendingError = null
        // Guard recovers: never re-throw.
        return
      }
      try {
        callback()
        lastSuccessAt = nowIso
        consecutiveErrors = 0
      } catch (err) {
        lastErrorAt = nowIso
        consecutiveErrors += 1
      }
    },

    heartbeat() {
      return {
        lastSuccessAt,
        lastErrorAt,
        consecutiveErrors,
      }
    },
  }

  return cron
}

/**
 * @param {object} opts
 * @param {Array<ReturnType<typeof makeMockMailbox>>} opts.mailboxes
 * @param {() => Date} [opts.fakeNow]
 */
export function makeMockEngine(opts = {}) {
  const fakeNow = typeof opts.fakeNow === 'function' ? opts.fakeNow : defaultNow
  const mailboxes = Array.isArray(opts.mailboxes) ? opts.mailboxes : []

  const eng = {
    mailboxes,
    dispatchedBatches: 0,
    daemonErrors: 0,
    breakerOpen: false,
    health: {
      status: 'ok', // 'ok' | 'stale' | 'down'
      last_seen_at: fakeNow().toISOString(),
    },

    run() {
      eng.dispatchedBatches += 1
      // Always refresh last_seen_at — even when the underlying clock returns
      // the same Date instance (jsdom defaults), bump by 1ms so consumers can
      // reliably detect activity.
      const next = new Date(fakeNow().getTime() + 1)
      eng.health = { ...eng.health, last_seen_at: next.toISOString() }
    },

    injectPanic() {
      eng.daemonErrors += 1
      eng.breakerOpen = true
      eng.health = { ...eng.health, status: 'down' }
    },

    supervisorRestart() {
      eng.breakerOpen = false
      eng.health = {
        status: 'ok',
        last_seen_at: fakeNow().toISOString(),
      }
    },
  }

  return eng
}

/**
 * Deeply frozen JSON-shaped snapshot of any object that exposes simple data
 * fields. Functions are stripped; nested arrays/objects are cloned so the
 * snapshot is safe from later mutation of the live source.
 *
 * @template T
 * @param {T} src
 * @returns {Readonly<T>}
 */
export function snapshotState(src) {
  const cloned = cloneJsonish(src)
  return deepFreeze(cloned)
}

/**
 * @param {any} v
 */
function cloneJsonish(v) {
  if (v === null || v === undefined) return v
  if (typeof v === 'function') return undefined
  if (Array.isArray(v)) return v.map(cloneJsonish).filter(x => x !== undefined)
  if (typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v)) {
      const cloned = cloneJsonish(v[k])
      if (cloned !== undefined) out[k] = cloned
    }
    return out
  }
  return v
}

/**
 * Diff two snapshots produced by snapshotState. Reports added / removed /
 * changed leaves. healingLog entries are diffed by `id`.
 *
 * @param {Record<string, any>} a
 * @param {Record<string, any>} b
 * @returns {{ added: any[], removed: any[], changed: Array<{ path: string, from: any, to: any }> }}
 */
export function diffSnapshots(a, b) {
  const added = []
  const removed = []
  const changed = []

  const aKeys = new Set(Object.keys(a || {}))
  const bKeys = new Set(Object.keys(b || {}))

  // Top-level keys present on either side.
  const allKeys = new Set([...aKeys, ...bKeys])
  for (const key of allKeys) {
    const av = a ? a[key] : undefined
    const bv = b ? b[key] : undefined
    if (key === 'healingLog') {
      const aLog = Array.isArray(av) ? av : []
      const bLog = Array.isArray(bv) ? bv : []
      const aIds = new Map(aLog.map(e => [e.id, e]))
      const bIds = new Map(bLog.map(e => [e.id, e]))
      for (const [id, entry] of bIds) {
        if (!aIds.has(id)) added.push(entry)
      }
      for (const [id, entry] of aIds) {
        if (!bIds.has(id)) removed.push(entry)
      }
      // Detect changes (e.g. resolved_at flipped from null → timestamp).
      for (const [id, aEntry] of aIds) {
        const bEntry = bIds.get(id)
        if (bEntry && JSON.stringify(aEntry) !== JSON.stringify(bEntry)) {
          changed.push({ path: `healingLog[id=${id}]`, from: aEntry, to: bEntry })
        }
      }
      continue
    }
    if (typeof av === 'object' || typeof bv === 'object') {
      // Shallow JSON compare for nested non-array objects.
      if (JSON.stringify(av) !== JSON.stringify(bv)) {
        changed.push({ path: key, from: av, to: bv })
      }
      continue
    }
    if (av !== bv) {
      changed.push({ path: key, from: av, to: bv })
    }
  }

  return { added, removed, changed }
}
