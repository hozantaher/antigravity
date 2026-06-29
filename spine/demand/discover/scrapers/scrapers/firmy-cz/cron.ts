/**
 * KT-A10 — firmy.cz refresh cron coordinator (TS side).
 *
 * Reads/writes the same `refresh_cron_state` PostgreSQL row that the Go
 * services/contacts/ares package uses, so a single source of truth governs
 * both refresh paths.
 *
 * Design: docs/initiatives/2026-04-30-kt-a10-refresh-cron-tuning-design.md
 */

import { createHash } from 'node:crypto';
import { Client as PgClient } from 'pg';

export const FIRMYCZ_SOURCE = 'firmycz';

export const MIN_INTERVAL_MS = 60 * 1000;
export const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MULTIPLIER = 1.5;
export const MIN_MULTIPLIER = 1.0;
export const MAX_MULTIPLIER = 3.0;

export type RefreshResult = 'success' | 'failure' | 'skipped';

export interface RefreshConfig {
  source: string;
  intervalMs: number;
  backoffCapMs: number;
  multiplier: number;
  batchSize: number;
}

export interface RefreshState {
  source: string;
  currentMultiplier: number;
  consecutiveFailures: number;
  lastRunAt: Date | null;
  lastStatus: RefreshResult | null;
  nextRunAt: Date | null;
  baseIntervalSeconds: number;
  backoffCapSeconds: number;
}

/**
 * Parse a duration string (e.g. "1h", "30m", "4h") into milliseconds.
 * Mirrors Go's time.ParseDuration so operators only need one syntax.
 */
export function parseDuration(input: string): number {
  const match = input.trim().match(/^(\d+)\s*(ms|s|m|h)$/);
  if (!match) {
    throw new Error(`neplatny duration format: ${input}`);
  }
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case 'ms':
      return value;
    case 's':
      return value * 1000;
    case 'm':
      return value * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    default:
      throw new Error(`neznama jednotka v duration: ${match[2]}`);
  }
}

/**
 * Build a RefreshConfig from environment variables. Defaults match the
 * design doc: firmy.cz baseline 4h cadence, 4h backoff cap, 1.5× ramp.
 */
export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RefreshConfig {
  const intervalRaw = env.FIRMYCZ_REFRESH_INTERVAL ?? '4h';
  const capRaw = env.FIRMYCZ_REFRESH_BACKOFF_CAP ?? '4h';
  const multRaw = env.FIRMYCZ_REFRESH_BACKOFF_MULTIPLIER ?? `${DEFAULT_MULTIPLIER}`;
  const batchRaw = env.FIRMYCZ_REFRESH_BATCH_SIZE ?? '500';

  const intervalMs = parseDuration(intervalRaw);
  const backoffCapMs = parseDuration(capRaw);
  const multiplier = parseFloat(multRaw);
  const batchSize = parseInt(batchRaw, 10);

  if (intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
    throw new Error(`FIRMYCZ_REFRESH_INTERVAL ${intervalRaw} mimo rozsah [1m..24h]`);
  }
  if (backoffCapMs < intervalMs || backoffCapMs > MAX_INTERVAL_MS) {
    throw new Error(`FIRMYCZ_REFRESH_BACKOFF_CAP ${capRaw} mimo rozsah [interval..24h]`);
  }
  if (Number.isNaN(multiplier) || multiplier < MIN_MULTIPLIER || multiplier > MAX_MULTIPLIER) {
    throw new Error(`FIRMYCZ_REFRESH_BACKOFF_MULTIPLIER ${multRaw} mimo rozsah [1.0..3.0]`);
  }
  if (Number.isNaN(batchSize) || batchSize <= 0) {
    throw new Error(`FIRMYCZ_REFRESH_BATCH_SIZE musi byt > 0, got ${batchRaw}`);
  }

  return {
    source: FIRMYCZ_SOURCE,
    intervalMs,
    backoffCapMs,
    multiplier,
    batchSize,
  };
}

/** Hash the source name into a deterministic Postgres advisory-lock key. */
export function advisoryLockKey(source: string): bigint {
  const hash = createHash('sha256').update(`refresh-cron-${source}`).digest();
  // Take the first 8 bytes as a big-endian unsigned int, mask off the
  // sign bit to keep the result inside positive int64 range.
  let key = 0n;
  for (let i = 0; i < 8; i++) {
    key = (key << 8n) | BigInt(hash[i]);
  }
  return key & 0x7fffffffffffffffn;
}

/** Fetch the persisted state row, or return defaults when none exists. */
export async function loadState(pg: PgClient, source: string = FIRMYCZ_SOURCE): Promise<RefreshState> {
  const result = await pg.query(
    `
    SELECT current_multiplier, consecutive_failures, last_run_at, last_status, next_run_at,
           base_interval_seconds, backoff_cap_seconds
      FROM refresh_cron_state
     WHERE source = $1
    `,
    [source],
  );
  if (result.rowCount === 0) {
    return {
      source,
      currentMultiplier: 1.0,
      consecutiveFailures: 0,
      lastRunAt: null,
      lastStatus: null,
      nextRunAt: null,
      baseIntervalSeconds: 0,
      backoffCapSeconds: 0,
    };
  }
  const row = result.rows[0];
  return {
    source,
    currentMultiplier: parseFloat(row.current_multiplier),
    consecutiveFailures: row.consecutive_failures,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    nextRunAt: row.next_run_at,
    baseIntervalSeconds: row.base_interval_seconds,
    backoffCapSeconds: row.backoff_cap_seconds,
  };
}

/** Compute the wall-clock instant of the next allowed tick. */
export function nextRunAt(state: RefreshState, cfg: RefreshConfig, now: Date): Date {
  if (!state.lastRunAt) return now;
  let waitMs = cfg.intervalMs * state.currentMultiplier;
  if (waitMs > cfg.backoffCapMs) waitMs = cfg.backoffCapMs;
  return new Date(state.lastRunAt.getTime() + waitMs);
}

/** True when the cron is allowed to run at `now`. */
export function shouldRun(state: RefreshState, cfg: RefreshConfig, now: Date): boolean {
  return now.getTime() >= nextRunAt(state, cfg, now).getTime();
}

/** Apply the per-failure ramp, bounded by cap/interval ceiling. */
export function rampMultiplier(current: number, cfg: RefreshConfig): number {
  const ceiling = Math.max(cfg.backoffCapMs / cfg.intervalMs, 1.0);
  const next = current * cfg.multiplier;
  if (next > ceiling) return ceiling;
  if (next < 1.0) return 1.0;
  return next;
}

/**
 * Persist the outcome of one tick. Mirrors the Go implementation:
 * success → multiplier=1.0, failures=0; failure → multiplier ramps;
 * skipped → state unchanged except last_status.
 */
export async function recordResult(
  pg: PgClient,
  cfg: RefreshConfig,
  result: RefreshResult,
  now: Date,
): Promise<RefreshState> {
  const prev = await loadState(pg, cfg.source);
  const next: RefreshState = { ...prev };
  next.baseIntervalSeconds = Math.floor(cfg.intervalMs / 1000);
  next.backoffCapSeconds = Math.floor(cfg.backoffCapMs / 1000);

  if (result === 'success') {
    next.currentMultiplier = 1.0;
    next.consecutiveFailures = 0;
    next.lastRunAt = now;
    next.lastStatus = 'success';
  } else if (result === 'failure') {
    next.currentMultiplier = rampMultiplier(prev.currentMultiplier, cfg);
    next.consecutiveFailures = prev.consecutiveFailures + 1;
    next.lastRunAt = now;
    next.lastStatus = 'failure';
  } else {
    next.lastStatus = 'skipped';
  }

  let waitMs = cfg.intervalMs * next.currentMultiplier;
  if (waitMs > cfg.backoffCapMs) waitMs = cfg.backoffCapMs;
  next.nextRunAt = next.lastRunAt ? new Date(next.lastRunAt.getTime() + waitMs) : prev.nextRunAt;

  await pg.query(
    `
    INSERT INTO refresh_cron_state
        (source, current_multiplier, consecutive_failures, last_run_at, last_status, next_run_at,
         base_interval_seconds, backoff_cap_seconds, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
    ON CONFLICT (source) DO UPDATE SET
        current_multiplier    = EXCLUDED.current_multiplier,
        consecutive_failures  = EXCLUDED.consecutive_failures,
        last_run_at           = COALESCE(EXCLUDED.last_run_at, refresh_cron_state.last_run_at),
        last_status           = EXCLUDED.last_status,
        next_run_at           = COALESCE(EXCLUDED.next_run_at, refresh_cron_state.next_run_at),
        base_interval_seconds = EXCLUDED.base_interval_seconds,
        backoff_cap_seconds   = EXCLUDED.backoff_cap_seconds,
        updated_at            = now()
    `,
    [
      cfg.source,
      next.currentMultiplier,
      next.consecutiveFailures,
      next.lastRunAt,
      next.lastStatus,
      next.nextRunAt,
      next.baseIntervalSeconds,
      next.backoffCapSeconds,
    ],
  );
  return next;
}

/** Acquire the per-source advisory lock. Pair with releaseLock(). */
export async function tryLock(pg: PgClient, source: string = FIRMYCZ_SOURCE): Promise<boolean> {
  const result = await pg.query<{ pg_try_advisory_lock: boolean }>(
    `SELECT pg_try_advisory_lock($1) AS pg_try_advisory_lock`,
    [advisoryLockKey(source).toString()],
  );
  return Boolean(result.rows[0]?.pg_try_advisory_lock);
}

export async function releaseLock(pg: PgClient, source: string = FIRMYCZ_SOURCE): Promise<void> {
  await pg.query(`SELECT pg_advisory_unlock($1)`, [advisoryLockKey(source).toString()]);
}

/** Structured breadcrumb data emitted alongside each tick. */
export interface BreadcrumbPayload {
  category: 'refresh-cron';
  message: string;
  data: {
    current_multiplier: number;
    consecutive_failures: number;
    next_run_at: Date | null;
    base_interval_ms: number;
    cap_ms: number;
    ico_batch_size: number;
    result: RefreshResult;
  };
}

export function buildBreadcrumb(state: RefreshState, cfg: RefreshConfig, result: RefreshResult): BreadcrumbPayload {
  return {
    category: 'refresh-cron',
    message: `refresh-${cfg.source} tick`,
    data: {
      current_multiplier: state.currentMultiplier,
      consecutive_failures: state.consecutiveFailures,
      next_run_at: state.nextRunAt,
      base_interval_ms: cfg.intervalMs,
      cap_ms: cfg.backoffCapMs,
      ico_batch_size: cfg.batchSize,
      result,
    },
  };
}
