import { describe, expect, it } from 'vitest';
import {
  advisoryLockKey,
  buildBreadcrumb,
  DEFAULT_MULTIPLIER,
  FIRMYCZ_SOURCE,
  loadConfigFromEnv,
  nextRunAt,
  parseDuration,
  rampMultiplier,
  shouldRun,
  type RefreshConfig,
  type RefreshState,
} from './cron.js';

const baseConfig = (): RefreshConfig => ({
  source: FIRMYCZ_SOURCE,
  intervalMs: 4 * 60 * 60 * 1000,
  backoffCapMs: 4 * 60 * 60 * 1000,
  multiplier: DEFAULT_MULTIPLIER,
  batchSize: 500,
});

const blankState = (): RefreshState => ({
  source: FIRMYCZ_SOURCE,
  currentMultiplier: 1.0,
  consecutiveFailures: 0,
  lastRunAt: null,
  lastStatus: null,
  nextRunAt: null,
  baseIntervalSeconds: 0,
  backoffCapSeconds: 0,
});

describe('parseDuration', () => {
  it('accepts hours', () => {
    expect(parseDuration('4h')).toBe(4 * 60 * 60 * 1000);
  });
  it('accepts minutes', () => {
    expect(parseDuration('30m')).toBe(30 * 60 * 1000);
  });
  it('rejects garbage', () => {
    expect(() => parseDuration('garbage')).toThrow();
  });
});

describe('loadConfigFromEnv', () => {
  it('returns defaults when no env override', () => {
    const cfg = loadConfigFromEnv({});
    expect(cfg.source).toBe(FIRMYCZ_SOURCE);
    expect(cfg.intervalMs).toBe(4 * 60 * 60 * 1000);
    expect(cfg.multiplier).toBeCloseTo(1.5);
  });
  it('honours FIRMYCZ_REFRESH_INTERVAL', () => {
    const cfg = loadConfigFromEnv({ FIRMYCZ_REFRESH_INTERVAL: '1h' });
    expect(cfg.intervalMs).toBe(60 * 60 * 1000);
  });
  it('rejects too-short interval', () => {
    expect(() => loadConfigFromEnv({ FIRMYCZ_REFRESH_INTERVAL: '500ms' })).toThrow();
  });
  it('rejects too-long interval', () => {
    expect(() => loadConfigFromEnv({ FIRMYCZ_REFRESH_INTERVAL: '48h' })).toThrow();
  });
  it('rejects multiplier below 1.0', () => {
    expect(() => loadConfigFromEnv({ FIRMYCZ_REFRESH_BACKOFF_MULTIPLIER: '0.5' })).toThrow();
  });
  it('rejects backoff cap below interval', () => {
    expect(() =>
      loadConfigFromEnv({
        FIRMYCZ_REFRESH_INTERVAL: '4h',
        FIRMYCZ_REFRESH_BACKOFF_CAP: '1h',
      }),
    ).toThrow();
  });
});

describe('rampMultiplier', () => {
  it('1.0 → 1.5 on first failure (interval=1h, cap=4h)', () => {
    const cfg: RefreshConfig = { ...baseConfig(), intervalMs: 60 * 60 * 1000, backoffCapMs: 4 * 60 * 60 * 1000 };
    expect(rampMultiplier(1.0, cfg)).toBeCloseTo(1.5);
  });
  it('caps at ceiling when interval == cap', () => {
    // interval == cap → ceiling = 1.0 → multiplier never exceeds 1.0.
    expect(rampMultiplier(1.0, baseConfig())).toBeCloseTo(1.0);
  });
  it('caps at ceiling for short interval / long cap combo', () => {
    const cfg: RefreshConfig = { ...baseConfig(), intervalMs: 60 * 60 * 1000, backoffCapMs: 4 * 60 * 60 * 1000 };
    // ceiling = 4
    expect(rampMultiplier(10, cfg)).toBeCloseTo(4.0);
  });
});

describe('nextRunAt', () => {
  it('never-run state is eligible immediately', () => {
    const cfg = baseConfig();
    const now = new Date('2026-04-30T12:00:00Z');
    expect(nextRunAt(blankState(), cfg, now).getTime()).toBe(now.getTime());
  });
  it('baseline waits one interval', () => {
    const cfg: RefreshConfig = { ...baseConfig(), intervalMs: 60 * 60 * 1000 };
    const now = new Date('2026-04-30T12:00:00Z');
    const state: RefreshState = { ...blankState(), lastRunAt: now };
    const next = nextRunAt(state, cfg, now);
    expect(next.getTime() - now.getTime()).toBe(60 * 60 * 1000);
  });
  it('mid-backoff waits multiplier × interval', () => {
    const cfg: RefreshConfig = { ...baseConfig(), intervalMs: 60 * 60 * 1000, backoffCapMs: 4 * 60 * 60 * 1000 };
    const now = new Date('2026-04-30T12:00:00Z');
    const state: RefreshState = { ...blankState(), lastRunAt: now, currentMultiplier: 2.25 };
    const expected = now.getTime() + 2.25 * 60 * 60 * 1000;
    expect(nextRunAt(state, cfg, now).getTime()).toBe(expected);
  });
  it('cap clamps a runaway multiplier', () => {
    const cfg: RefreshConfig = { ...baseConfig(), intervalMs: 60 * 60 * 1000, backoffCapMs: 4 * 60 * 60 * 1000 };
    const now = new Date('2026-04-30T12:00:00Z');
    const state: RefreshState = { ...blankState(), lastRunAt: now, currentMultiplier: 10.0 };
    expect(nextRunAt(state, cfg, now).getTime() - now.getTime()).toBe(4 * 60 * 60 * 1000);
  });
});

describe('shouldRun', () => {
  it('false when before next_run_at', () => {
    const cfg: RefreshConfig = { ...baseConfig(), intervalMs: 60 * 60 * 1000 };
    const last = new Date('2026-04-30T12:00:00Z');
    const state: RefreshState = { ...blankState(), lastRunAt: last };
    const before = new Date(last.getTime() + 30 * 60 * 1000);
    expect(shouldRun(state, cfg, before)).toBe(false);
  });
  it('true when at or after next_run_at', () => {
    const cfg: RefreshConfig = { ...baseConfig(), intervalMs: 60 * 60 * 1000 };
    const last = new Date('2026-04-30T12:00:00Z');
    const state: RefreshState = { ...blankState(), lastRunAt: last };
    const at = new Date(last.getTime() + 60 * 60 * 1000);
    expect(shouldRun(state, cfg, at)).toBe(true);
  });
});

describe('advisoryLockKey', () => {
  it('is deterministic per source', () => {
    expect(advisoryLockKey('firmycz')).toBe(advisoryLockKey('firmycz'));
  });
  it('differs between sources', () => {
    expect(advisoryLockKey('firmycz')).not.toBe(advisoryLockKey('ares'));
  });
  it('is non-negative', () => {
    expect(advisoryLockKey('firmycz')).toBeGreaterThanOrEqual(0n);
    expect(advisoryLockKey('ares')).toBeGreaterThanOrEqual(0n);
  });
});

describe('buildBreadcrumb', () => {
  it('contains required fields', () => {
    const cfg = baseConfig();
    const state: RefreshState = {
      ...blankState(),
      currentMultiplier: 1.5,
      consecutiveFailures: 1,
      nextRunAt: new Date('2026-04-30T13:30:00Z'),
    };
    const bc = buildBreadcrumb(state, cfg, 'failure');
    expect(bc.category).toBe('refresh-cron');
    expect(bc.message).toBe('refresh-firmycz tick');
    expect(bc.data.current_multiplier).toBe(1.5);
    expect(bc.data.consecutive_failures).toBe(1);
    expect(bc.data.ico_batch_size).toBe(500);
    expect(bc.data.result).toBe('failure');
  });
});
