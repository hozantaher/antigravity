/**
 * Enrichment worker primitives — rate limiting, circuit breaker, backoff,
 * idempotent persistence, and the per-tick orchestrator.
 *
 * Design notes:
 *  - Token bucket per source. Refills at rate_limit_per_min/60s.
 *    Gives bursts up to `capacity` then throttles linearly.
 *  - Circuit breaker opens after N consecutive failures, stays open for
 *    `cooldownMs`. Cuts noise from a temporarily-down upstream and stops
 *    burning rate-limit budget on guaranteed failures.
 *  - Backoff: exponential with capped retries. After `MAX_ATTEMPTS`,
 *    job moves to 'dead' and an alert is logged.
 *  - Persistence is idempotent via UNIQUE INDEX on
 *    (company_id, source, field, fetched_at::date) — same fact same day
 *    = single row. Reruns are safe.
 *  - Job claiming uses FOR UPDATE SKIP LOCKED so multiple workers can
 *    pull from the same queue without deadlocking.
 */

export const BACKOFF_SECONDS = Object.freeze([60, 300, 1800, 6 * 3600, 24 * 3600])
export const MAX_ATTEMPTS = BACKOFF_SECONDS.length

export function backoffSeconds(attempt) {
  const a = Math.max(0, Math.floor(Number(attempt) || 0))
  if (a >= BACKOFF_SECONDS.length) return BACKOFF_SECONDS[BACKOFF_SECONDS.length - 1]
  return BACKOFF_SECONDS[a]
}

export class SourceRateLimiter {
  constructor(perMinute, now = () => Date.now()) {
    this.capacity = Math.max(1, Number(perMinute) || 1)
    this.tokens = this.capacity
    this.refillPerMs = this.capacity / 60_000
    this.lastRefill = now()
    this._now = now
  }
  _refill() {
    const t = this._now()
    const delta = Math.max(0, t - this.lastRefill)
    this.tokens = Math.min(this.capacity, this.tokens + delta * this.refillPerMs)
    this.lastRefill = t
  }
  /** Available tokens right now (after refill). Useful for tests. */
  available() { this._refill(); return this.tokens }
  /** Try to take 1 token without waiting. Returns true if granted. */
  tryTake() {
    this._refill()
    if (this.tokens >= 1) { this.tokens -= 1; return true }
    return false
  }
  /** ms until next token is available (0 if available now). */
  msUntilNextToken() {
    this._refill()
    if (this.tokens >= 1) return 0
    return Math.ceil((1 - this.tokens) / this.refillPerMs)
  }
  /** Block until a token is available, then consume it. */
  async take(sleep = ms => new Promise(r => setTimeout(r, ms))) {
    const wait = this.msUntilNextToken()
    if (wait > 0) await sleep(wait)
    this._refill()
    this.tokens = Math.max(0, this.tokens - 1)
  }
}

export class CircuitBreaker {
  constructor(threshold = 5, cooldownMs = 5 * 60_000, now = () => Date.now()) {
    this.threshold = Math.max(1, Number(threshold) || 1)
    this.cooldownMs = Math.max(0, Number(cooldownMs) || 0)
    this.failures = 0
    this.openedAt = 0
    this._now = now
  }
  isOpen() {
    if (!this.openedAt) return false
    if (this._now() - this.openedAt > this.cooldownMs) {
      this.openedAt = 0
      this.failures = 0
      return false
    }
    return true
  }
  recordSuccess() { this.failures = 0; this.openedAt = 0 }
  recordFailure() {
    this.failures += 1
    if (this.failures >= this.threshold) this.openedAt = this._now()
  }
}

/**
 * Insert facts. Each fact:
 *   { field: string, value: any, base_confidence?: number, ttl_days?: number }
 * confidence falls back to source.base_confidence when omitted.
 * Returns inserted row count.
 */
export async function persistFacts(pool, companyId, source, facts, parserVersion = null, defaults = {}) {
  if (!Array.isArray(facts) || facts.length === 0) return 0
  const baseConf = Number.isFinite(defaults.base_confidence) ? defaults.base_confidence : 0.7
  const baseTtl  = Number.isFinite(defaults.ttl_days)        ? defaults.ttl_days        : 90
  let inserted = 0
  for (const f of facts) {
    if (!f || typeof f.field !== 'string' || f.field.length === 0 || f.value === undefined) continue
    const conf = Number.isFinite(f.base_confidence) ? f.base_confidence : baseConf
    const ttl  = Number.isFinite(f.ttl_days)        ? f.ttl_days        : baseTtl
    try {
      const r = await pool.query(`
        INSERT INTO company_facts (company_id, source, field, value, base_confidence, ttl_days, parser_version)
        VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
        ON CONFLICT (company_id, source, field, ((fetched_at AT TIME ZONE 'UTC')::date))
        DO NOTHING
      `, [companyId, source, f.field, JSON.stringify(f.value), conf, ttl, parserVersion])
      inserted += r.rowCount || 0
    } catch (e) {
      throw new Error(`persistFacts ${source}.${f.field}: ${e.message}`)
    }
  }
  return inserted
}

/**
 * Claim up to `batchSize` pending jobs for a source.
 * SKIP LOCKED → other workers don't block, they take other rows.
 */
export async function claimJobs(pool, source, batchSize = 10) {
  const { rows } = await pool.query(`
    UPDATE enrichment_jobs SET status='running', attempt=attempt+1, started_at=now()
     WHERE id IN (
       SELECT id FROM enrichment_jobs
        WHERE source=$1 AND status='pending' AND scheduled_at <= now()
        ORDER BY scheduled_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id, company_id, source, attempt
  `, [source, (() => {
    const n = Number(batchSize)
    return Math.max(1, Math.min(100, Number.isFinite(n) ? n : 10))
  })()])
  return rows
}

export async function markJobDone(pool, jobId) {
  await pool.query(
    `UPDATE enrichment_jobs SET status='done', finished_at=now(), last_error=NULL WHERE id=$1`,
    [jobId],
  )
}

export async function markJobFailed(pool, jobId, attempt, errorMessage) {
  const dead = attempt >= MAX_ATTEMPTS
  const nextSec = dead ? null : backoffSeconds(attempt)
  await pool.query(`
    UPDATE enrichment_jobs
       SET status        = $1,
           scheduled_at  = CASE WHEN $2::int IS NULL THEN scheduled_at
                                ELSE now() + ($2 || ' seconds')::interval END,
           last_error    = $3,
           finished_at   = CASE WHEN $1 = 'dead' THEN now() ELSE NULL END
     WHERE id = $4
  `, [dead ? 'dead' : 'pending', nextSec, errorMessage, jobId])
}

/**
 * Schedule a fresh job for (company, source) if no pending/running job exists.
 * Returns true if newly enqueued, false if a duplicate already in-flight.
 */
export async function enqueueJob(pool, companyId, source, scheduledAt = null) {
  try {
    const r = await pool.query(`
      INSERT INTO enrichment_jobs (company_id, source, scheduled_at)
      VALUES ($1, $2, COALESCE($3::timestamptz, now()))
      ON CONFLICT (company_id, source) WHERE status IN ('pending','running')
      DO NOTHING
      RETURNING id
    `, [companyId, source, scheduledAt])
    return r.rowCount > 0
  } catch (e) {
    // Postgres < 15 may not parse partial-index ON CONFLICT — fallback.
    const r = await pool.query(`
      INSERT INTO enrichment_jobs (company_id, source, scheduled_at)
      SELECT $1, $2, COALESCE($3::timestamptz, now())
       WHERE NOT EXISTS (
         SELECT 1 FROM enrichment_jobs
          WHERE company_id=$1 AND source=$2 AND status IN ('pending','running')
       )
      RETURNING id
    `, [companyId, source, scheduledAt])
    return r.rowCount > 0
  }
}

/**
 * Run one tick of the worker loop. For each enabled source:
 *   - skip if breaker open
 *   - claim batch
 *   - per job: take rate-limit token, run parser, persist or fail
 * `parsers` is { sourceName: async (companyId) => Array<fact> }
 */
export async function runWorkerTick(pool, { sources, parsers, limiters, breakers, batchSize = 10 }) {
  const summary = []
  for (const src of sources) {
    if (!src.enabled) continue
    const breaker = breakers.get(src.source)
    const limiter = limiters.get(src.source)
    const parser  = parsers[src.source]
    if (!breaker || !limiter || !parser) continue
    if (breaker.isOpen()) {
      summary.push({ source: src.source, skipped: 'breaker_open' })
      continue
    }
    const jobs = await claimJobs(pool, src.source, batchSize)
    let ok = 0, failed = 0
    for (const job of jobs) {
      await limiter.take()
      try {
        const facts = await parser(job.company_id)
        await persistFacts(pool, job.company_id, src.source, facts, parser.version || null, {
          base_confidence: src.base_confidence,
          ttl_days:        src.default_ttl_days,
        })
        await markJobDone(pool, job.id)
        breaker.recordSuccess()
        ok++
      } catch (e) {
        breaker.recordFailure()
        await markJobFailed(pool, job.id, job.attempt, String(e?.message || e).slice(0, 500))
        failed++
      }
    }
    if (jobs.length) summary.push({ source: src.source, ok, failed })
  }
  return summary
}
