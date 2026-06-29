import { gunzipSync } from 'zlib';
import { logger } from './logger.js';
import type { ProgressStats } from './types.js';

/** Try to decompress a gzipped Buffer. Returns UTF-8 string on success, null on non-gzip or failure. */
export function tryGunzip(val: unknown): string | null {
  if (!(val instanceof Buffer) || val.length < 2 || val[0] !== 0x1f || val[1] !== 0x8b) return null;
  try {
    return gunzipSync(val).toString('utf-8');
  } catch {
    return null;
  }
}

// Adaptive rate limiter - backs off on 429, recovers after successes
export const createRateLimiter = (baseDelayMs: number) => {
  let nextAllowedTime = 0;
  let currentDelay = baseDelayMs;
  let consecutiveSuccesses = 0;
  const minDelay = baseDelayMs;
  const maxDelay = baseDelayMs * 10;

  const wait = async (): Promise<void> => {
    const now = Date.now();
    const waitUntil = nextAllowedTime;
    // Add ±30% jitter to make timing look human
    const jitter = currentDelay * (0.7 + Math.random() * 0.6);
    nextAllowedTime = Math.max(now, waitUntil) + Math.round(jitter);
    if (waitUntil > now) {
      await new Promise((resolve) => setTimeout(resolve, waitUntil - now));
    }
  };

  const onSuccess = () => {
    consecutiveSuccesses++;
    // After 20 consecutive successes, try reducing delay
    if (consecutiveSuccesses >= 20 && currentDelay > minDelay) {
      currentDelay = Math.max(minDelay, Math.floor(currentDelay * 0.75));
      consecutiveSuccesses = 0;
      logger.info({ delay_ms: currentDelay }, 'rate_limiter_delay_decreased');
    }
  };

  const onRateLimited = (retryAfterSec?: number) => {
    consecutiveSuccesses = 0;
    const pauseSec = retryAfterSec ?? Math.ceil((currentDelay * 1.5) / 1000);
    currentDelay = Math.min(maxDelay, Math.ceil(currentDelay * 1.5));
    // Push nextAllowedTime forward so queued workers also wait
    nextAllowedTime = Math.max(nextAllowedTime, Date.now() + pauseSec * 1000);
    logger.info({ delay_ms: currentDelay, pause_sec: pauseSec }, 'rate_limiter_rate_limited');
  };

  return { wait, onSuccess, onRateLimited, getDelay: () => currentDelay };
};

// Retry with exponential backoff
export const retry = async <T>(
  fn: () => Promise<T>,
  opts: { maxRetries: number; baseDelay?: number; onRetry?: (attempt: number, error: Error) => void },
): Promise<T> => {
  const { maxRetries, baseDelay = 1000, onRetry } = opts;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 500;
        onRetry?.(attempt + 1, lastError);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
};

// Progress tracker with ETA calculation
export const createProgressTracker = (
  total: number,
): ProgressStats & {
  increment: () => void;
  incrementFailed: () => void;
  report: () => string;
  getStats: () => { scraped: number; failed: number; total: number };
} => {
  const stats: ProgressStats = {
    total,
    scraped: 0,
    failed: 0,
    startedAt: Date.now(),
  };

  const formatTime = (ms: number): string => {
    const seconds = Math.floor(ms / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  };

  const timestamp = (): string => {
    const now = new Date();
    return now.toTimeString().slice(0, 8);
  };

  return {
    ...stats,
    increment: () => {
      stats.scraped++;
    },
    incrementFailed: () => {
      stats.failed++;
    },
    report: () => {
      const done = stats.scraped + stats.failed;
      const pct = stats.total > 0 ? ((done / stats.total) * 100).toFixed(1) : '0.0';
      const elapsed = Date.now() - stats.startedAt;
      const rate = elapsed > 0 ? (done / (elapsed / 1000)).toFixed(1) : '0.0';
      const remaining = done > 0 ? ((stats.total - done) / (done / (elapsed / 1000))) * 1000 : 0;
      const eta = done > 0 ? formatTime(remaining) : '?';
      return `[${timestamp()}] ${done.toLocaleString()} / ${stats.total.toLocaleString()} (${pct}%) | ${rate}/s | ETA: ${eta} | Failed: ${stats.failed}`;
    },
    getStats: () => ({ scraped: stats.scraped, failed: stats.failed, total: stats.total }),
  };
};

// Graceful shutdown handler
export const createShutdownHandler = (): {
  isShuttingDown: () => boolean;
  onShutdown: (callback: () => Promise<void> | void) => void;
  setup: () => void;
} => {
  let shuttingDown = false;
  const callbacks: Array<() => Promise<void> | void> = [];

  return {
    isShuttingDown: () => shuttingDown,
    onShutdown: (callback) => {
      callbacks.push(callback);
    },
    setup: () => {
      const handler = async () => {
        if (shuttingDown) {
          logger.info('force_exit');
          process.exit(1);
        }
        shuttingDown = true;
        logger.info('shutdown_graceful_start');
        for (const cb of callbacks) {
          await cb();
        }
      };
      process.on('SIGINT', handler);
      process.on('SIGTERM', handler);
    },
  };
};
