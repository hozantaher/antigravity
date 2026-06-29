// HXX10 — Storm-resilient heal idempotency.
//
// Dedupes heal requests on (entity_id + heal_kind) within a sliding window.
// First request in window wins; subsequent requests within the same window
// are deduped (applied=false) but counted into storm_size.
//
// Window semantics: a window opens at the timestamp of the first applied
// request. While `now - window_start < window_ms`, every subsequent
// (entity_id, heal_kind) request is deduped and storm_size increments.
// After the window expires, the next request opens a fresh window with a
// new dedup_key (the key embeds the window_start timestamp so post-window
// requests get a different key).
//
// Boundary edges:
//   window_ms = 0       → every request applied (window never overlaps)
//   window_ms = Infinity → only the first request ever applied
//
// Memory: lazy TTL eviction on every request — entries whose window has
// fully expired are dropped. Bounds memory at "active windows", not lifetime
// requests.
//
// Observability: optional `onStorm` callback fires once per window when
// storm_size crosses the high-storm threshold (default 100). Used to emit
// Sentry breadcrumbs / tags.

const HIGH_STORM_THRESHOLD = 100

/**
 * @typedef {object} DeduperEntry
 * @property {number} window_start  ms timestamp when the window opened
 * @property {number} storm_size    count of requests within this window
 * @property {boolean} high_storm_emitted  whether onStorm has fired for this window
 */

/**
 * @typedef {object} RequestResult
 * @property {boolean} applied      true on first request in window, false on dedup
 * @property {string}  dedup_key    composite key including the window bucket
 * @property {number}  storm_size   number of requests in the current window
 */

export class HealDeduper {
  /**
   * @param {object} opts
   * @param {number} [opts.window_ms]       sliding window length in ms (default 30_000)
   * @param {() => number} [opts.now]       clock injection for tests
   * @param {(info: { tag: string, dedup_key: string, storm_size: number, entity_id: string, heal_kind: string }) => void} [opts.onStorm]
   * @param {number} [opts.high_storm_threshold]  default 100
   */
  constructor({ window_ms = 30_000, now = () => Date.now(), onStorm, high_storm_threshold = HIGH_STORM_THRESHOLD } = {}) {
    if (typeof now !== 'function') {
      throw new Error('HealDeduper: now must be a function')
    }
    if (typeof window_ms !== 'number' || Number.isNaN(window_ms) || window_ms < 0) {
      throw new Error('HealDeduper: window_ms must be a non-negative number')
    }
    this._window_ms = window_ms
    this._now = now
    this._onStorm = typeof onStorm === 'function' ? onStorm : null
    this._high_storm = high_storm_threshold
    /** @type {Map<string, DeduperEntry>} */
    this._entries = new Map()  // composite (entity|kind) → entry
  }

  /**
   * Compose the bucket-aware dedup key. Embedding the window_start makes the
   * key collision-safe across windows: same params after expiry yield a
   * different key.
   *
   * @param {string} entity_id
   * @param {string} heal_kind
   * @param {number} window_start
   * @returns {string}
   */
  _composeKey(entity_id, heal_kind, window_start) {
    return `${entity_id}|${heal_kind}|w=${window_start}`
  }

  _composite(entity_id, heal_kind) {
    return `${entity_id}|${heal_kind}`
  }

  _isExpired(entry, now) {
    if (this._window_ms === Infinity) return false
    if (this._window_ms === 0) return true  // zero-window: always expired
    return now - entry.window_start >= this._window_ms
  }

  _evictExpired(now) {
    if (this._window_ms === Infinity) return  // never expire
    for (const [key, entry] of this._entries) {
      if (this._isExpired(entry, now)) {
        this._entries.delete(key)
      }
    }
  }

  /**
   * Record a heal request. First-in-window wins; subsequent within window are deduped.
   *
   * @param {string} entity_id
   * @param {string} heal_kind
   * @returns {RequestResult}
   */
  request(entity_id, heal_kind) {
    if (!entity_id || typeof entity_id !== 'string') {
      throw new Error('HealDeduper.request: entity_id is required (non-empty string)')
    }
    if (!heal_kind || typeof heal_kind !== 'string') {
      throw new Error('HealDeduper.request: heal_kind is required (non-empty string)')
    }

    const now = this._now()
    // Lazy eviction: drop fully-expired entries every call to bound memory.
    this._evictExpired(now)

    // window_ms === 0 → every request is its own window: applied=true, storm_size=1
    if (this._window_ms === 0) {
      const window_start = now
      const dedup_key = this._composeKey(entity_id, heal_kind, window_start)
      // Don't store anything — zero-window has no history.
      return { applied: true, dedup_key, storm_size: 1 }
    }

    const composite = this._composite(entity_id, heal_kind)
    const existing = this._entries.get(composite)

    if (!existing || this._isExpired(existing, now)) {
      // Open a fresh window. First request wins.
      const entry = {
        window_start: now,
        storm_size: 1,
        high_storm_emitted: false,
      }
      this._entries.set(composite, entry)
      const dedup_key = this._composeKey(entity_id, heal_kind, entry.window_start)
      return { applied: true, dedup_key, storm_size: 1 }
    }

    // Within active window → dedup.
    existing.storm_size += 1
    const dedup_key = this._composeKey(entity_id, heal_kind, existing.window_start)

    // Storm callback (fires once per window crossing the threshold).
    if (
      this._onStorm
      && !existing.high_storm_emitted
      && existing.storm_size > this._high_storm
    ) {
      existing.high_storm_emitted = true
      try {
        this._onStorm({
          tag: 'high-storm',
          dedup_key,
          storm_size: existing.storm_size,
          entity_id,
          heal_kind,
        })
      } catch {
        // Never let observability throw into the hot path.
      }
    }

    return { applied: false, dedup_key, storm_size: existing.storm_size }
  }

  /**
   * Map of dedup_key → storm_size for all currently-active (non-expired) windows.
   * Returned as a Map so insertion order is preserved.
   *
   * @returns {Map<string, number>}
   */
  stats() {
    const now = this._now()
    this._evictExpired(now)
    const out = new Map()
    for (const [composite, entry] of this._entries) {
      const [entity_id, heal_kind] = composite.split('|')
      const dedup_key = this._composeKey(entity_id, heal_kind, entry.window_start)
      out.set(dedup_key, entry.storm_size)
    }
    return out
  }

  /**
   * Build a healing_log row for a deduped request. Mirrors the production
   * healing_log schema; storm_size + dedup_key are added so the dashboard can
   * group dedup rows by storm.
   *
   * @param {string} entity_id
   * @param {string} heal_kind
   * @returns {object|null}  null if no active window for this key
   */
  toHealingLogRow(entity_id, heal_kind) {
    const now = this._now()
    const composite = this._composite(entity_id, heal_kind)
    const entry = this._entries.get(composite)
    if (!entry || this._isExpired(entry, now)) return null
    const dedup_key = this._composeKey(entity_id, heal_kind, entry.window_start)
    return {
      entity_type: 'mailbox',
      entity_id,
      action: 'heal_dedup',
      reason: `dedup window storm_size=${entry.storm_size} kind=${heal_kind}`,
      dedup_key,
      storm_size: entry.storm_size,
      created_at: new Date(now).toISOString(),
      resolved_at: null,
    }
  }
}
