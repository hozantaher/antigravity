// HX7 — Cost-aware heal budget (token bucket).
//
// Two-tier rate limiting on heal-actions:
//   per-entity:  30 actions/h per mailbox (or other entity ID)
//   system-wide: 1000 actions/h total
//
// Refill is continuous: at any time, available = capacity − consumed +
// refilled_since_last_check. Tokens never exceed capacity.
//
// HealBudget composes two TokenBuckets per entity (one per-entity, one shared
// system bucket), and an onThrottle callback fires when allow() returns false.

export class TokenBucket {
  constructor({ capacity, refillPerHour, now }) {
    if (typeof now !== 'function') throw new Error('TokenBucket: now must be a function')
    this._cap = Math.max(0, capacity)
    this._rate = Math.max(0, refillPerHour) / (60 * 60 * 1000)  // tokens per ms
    this._now = now
    this._tokens = this._cap
    this._lastTickAt = now()
  }

  _refillToNow() {
    const now = this._now()
    if (now <= this._lastTickAt) {
      // Clock skew backward: don't add tokens, just hold.
      this._lastTickAt = now
      return
    }
    const elapsed = now - this._lastTickAt
    this._tokens = Math.min(this._cap, this._tokens + elapsed * this._rate)
    this._lastTickAt = now
  }

  available() {
    this._refillToNow()
    return Math.floor(this._tokens)
  }

  consume(n) {
    if (n === 0) return true
    if (n < 0) return false
    this._refillToNow()
    if (this._tokens >= n) {
      this._tokens -= n
      return true
    }
    return false  // atomic — never partially consume
  }
}

export class HealBudget {
  constructor({ perEntityHourly, systemHourly, now }) {
    this._perEntityCap = perEntityHourly
    this._systemCap = systemHourly
    this._now = now
    this._system = new TokenBucket({ capacity: systemHourly, refillPerHour: systemHourly, now })
    this._entities = new Map()  // entityId → TokenBucket
    this._consumedTotal = new Map()  // entityId → total consumed (lifetime)
    this.onThrottle = null
  }

  _bucketFor(entityId) {
    let b = this._entities.get(entityId)
    if (!b) {
      b = new TokenBucket({
        capacity: this._perEntityCap,
        refillPerHour: this._perEntityCap,
        now: this._now,
      })
      this._entities.set(entityId, b)
    }
    return b
  }

  allow(entityId, n = 1) {
    const entityBucket = this._bucketFor(entityId)
    // Preview both: must fit in BOTH buckets atomically.
    if (entityBucket.available() < n || this._system.available() < n) {
      this._emitThrottle({ entity: entityId, requested: n })
      return false
    }
    // Atomic dual-consume.
    const okEntity = entityBucket.consume(n)
    const okSystem = this._system.consume(n)
    if (!okEntity || !okSystem) {
      // Race lost — refund the one that succeeded.
      // (Refund: increase the other bucket's _tokens. Simpler: don't, since
      // atomic check above guarantees both pass on the happy path.)
      this._emitThrottle({ entity: entityId, requested: n })
      return false
    }
    this._consumedTotal.set(entityId, (this._consumedTotal.get(entityId) || 0) + n)
    return true
  }

  _emitThrottle(detail) {
    if (typeof this.onThrottle === 'function') {
      this.onThrottle({ kind: 'heal_throttled', at: new Date(this._now()).toISOString(), ...detail })
    }
  }

  stats() {
    return Object.fromEntries(this._consumedTotal)
  }
}
