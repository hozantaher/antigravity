// HXX11 — Cross-region disaster recovery coordinator.
// Pure-JS sim of primary→secondary failover via shared DB heartbeat.
// Production wires this over Postgres `region_active_until` timestamps with
// a single-row `heartbeat` table; advisory lock arbitrates contention.

export const REGION_STATES = Object.freeze({
  PRIMARY:   'primary',
  SECONDARY: 'secondary',
  FAILED:    'failed',
})

export class RegionFailoverCoordinator {
  constructor(opts) {
    if (!opts || !Array.isArray(opts.regions) || opts.regions.length === 0) {
      throw new Error('RegionFailoverCoordinator: regions must be non-empty array')
    }
    this.regions = [...opts.regions]
    this.heartbeatTtlMs = opts.heartbeatTtlMs ?? 30 * 1000
    this.now = opts.now || (() => Date.now())
    this._lastHeartbeat = new Map()  // region → timestamp
    this._activeRegion = null
    this._activeUntil = -Infinity
    this._failoverHistory = []
    this._transactions = new Set()  // shared "DB" transaction log
  }

  heartbeat(region, timestamp) {
    if (!this.regions.includes(region)) {
      throw new Error(`RegionFailoverCoordinator: unknown region ${region}`)
    }
    const t = timestamp ?? this.now()
    this._lastHeartbeat.set(region, t)
    // If no active OR active is stale, this region claims primary.
    if (this._activeRegion === null || t > this._activeUntil) {
      const oldActive = this._activeRegion
      if (oldActive !== region) {
        this._activeRegion = region
        this._activeUntil = t + this.heartbeatTtlMs
        if (oldActive !== null) {
          this._failoverHistory.push({ from: oldActive, to: region, at: t })
        }
      } else {
        // Same region renewing — extend lease.
        this._activeUntil = t + this.heartbeatTtlMs
      }
    }
    // If a different region heartbeats while active is alive, ignore (split-brain prevention).
  }

  activeRegion() {
    if (this._activeRegion === null) return null
    const now = this.now()
    if (now > this._activeUntil) return null  // active region has gone stale
    return this._activeRegion
  }

  failoverHistory() {
    return [...this._failoverHistory]
  }

  recordTransaction(txId) {
    this._transactions.add(txId)
  }

  getTransactions() {
    return [...this._transactions]
  }
}
