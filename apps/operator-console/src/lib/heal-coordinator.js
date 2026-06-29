// HX6 — In-memory advisory-lock-like coordinator for heal actions.
//
// Models the SEMANTIC of pg_try_advisory_lock(mb_id) used in
// services/campaigns/campaign/scheduler_postgres.go: when N concurrent
// heal attempts target the same mailbox, exactly one wins; the others
// must skip cleanly without blocking. Stale-lock recovery covers the
// case where the holder crashes before release() — in Postgres this is
// handled by session-bound locks; here we expose releaseStale(maxAge).
//
// NOT a replacement for real pg advisory locks across processes. This
// fixture is for in-process tests of the coordination semantic only.

/**
 * @typedef {object} LockState
 * @property {string} holderId
 * @property {number} acquiredAt ms epoch when the lock was acquired
 */

/**
 * @typedef {object} TryAcquireResult
 * @property {boolean} acquired
 * @property {string} [holderId] currently-holding holderId when acquired=false
 */

/**
 * @typedef {object} RunUnderLockResult
 * @property {boolean} [skipped] true if the lock was held by another holder
 * @property {string} [reason]   short human reason when skipped=true
 * @property {*} [value]         return value of fn when skipped is falsy
 */

function assertNonEmptyString(label, value) {
  if (value === null || value === undefined || typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
}

export class HealCoordinator {
  constructor() {
    /** @type {Map<string, LockState>} */
    this._locks = new Map()
  }

  /**
   * Try to acquire the lock for `entityId`. Non-reentrant: if any holder
   * (including the same holderId) currently holds it, the call returns
   * { acquired: false, holderId: <current> }.
   *
   * @param {string} entityId
   * @param {string} holderId
   * @param {number} [now] ms epoch override (default Date.now())
   * @returns {TryAcquireResult}
   */
  tryAcquire(entityId, holderId, now) {
    assertNonEmptyString('entityId', entityId)
    assertNonEmptyString('holderId', holderId)
    const existing = this._locks.get(entityId)
    if (existing) {
      return { acquired: false, holderId: existing.holderId }
    }
    const acquiredAt = Number.isFinite(now) ? now : Date.now()
    this._locks.set(entityId, { holderId, acquiredAt })
    return { acquired: true }
  }

  /**
   * Release the lock for `entityId` IF it is held by `holderId`. Releases
   * by a non-owner are no-ops (mirrors pg_advisory_unlock semantics where
   * a session can only release its own locks).
   *
   * @param {string} entityId
   * @param {string} holderId
   * @returns {boolean} true if the lock was released
   */
  release(entityId, holderId) {
    if (typeof entityId !== 'string' || entityId.length === 0) return false
    if (typeof holderId !== 'string' || holderId.length === 0) return false
    const existing = this._locks.get(entityId)
    if (!existing) return false
    if (existing.holderId !== holderId) return false
    this._locks.delete(entityId)
    return true
  }

  /**
   * Run `fn` under the lock for `entityId`. If the lock cannot be
   * acquired, returns { skipped: true, reason } without invoking fn.
   * On success, the lock is released BEFORE the promise resolves —
   * including when fn throws synchronously or rejects asynchronously.
   *
   * @template T
   * @param {string} entityId
   * @param {string} holderId
   * @param {() => Promise<T>|T} fn
   * @returns {Promise<RunUnderLockResult>}
   */
  async runUnderLock(entityId, holderId, fn) {
    const acq = this.tryAcquire(entityId, holderId)
    if (!acq.acquired) {
      return { skipped: true, reason: `held_by:${acq.holderId}` }
    }
    try {
      const value = await fn()
      return { value }
    } finally {
      this.release(entityId, holderId)
    }
  }

  /**
   * Evict locks held longer than `maxAgeMs` relative to `now`. Models
   * the recovery path for crashed holders that never called release().
   *
   * @param {number} maxAgeMs
   * @param {number} now ms epoch
   * @returns {number} number of locks evicted
   */
  releaseStale(maxAgeMs, now) {
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) return 0
    if (!Number.isFinite(now)) return 0
    let evicted = 0
    for (const [entityId, state] of this._locks) {
      if (now - state.acquiredAt > maxAgeMs) {
        this._locks.delete(entityId)
        evicted += 1
      }
    }
    return evicted
  }

  /**
   * @returns {number} count of currently-held locks
   */
  size() {
    return this._locks.size
  }
}
