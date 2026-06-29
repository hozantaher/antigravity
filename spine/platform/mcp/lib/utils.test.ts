import { createRateLimiter, retry, createProgressTracker, createShutdownHandler } from './utils.js';
import { logger } from './logger.js';

describe('createRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with base delay', () => {
    const rl = createRateLimiter(1000);
    expect(rl.getDelay()).toBe(1000);
  });

  it('decreases delay after 20 consecutive successes', () => {
    const rl = createRateLimiter(1000);
    // First increase delay via rate limit
    rl.onRateLimited();
    expect(rl.getDelay()).toBe(1500);
    // Now 20 successes should decrease it
    for (let i = 0; i < 20; i++) {
      rl.onSuccess();
    }
    expect(rl.getDelay()).toBeLessThan(1500);
  });

  it('does not decrease below base delay', () => {
    const rl = createRateLimiter(100);
    for (let i = 0; i < 100; i++) {
      rl.onSuccess();
    }
    expect(rl.getDelay()).toBe(100);
  });

  it('increases delay on rate limit', () => {
    const rl = createRateLimiter(1000);
    rl.onRateLimited();
    expect(rl.getDelay()).toBe(1500);
  });

  it('caps delay at 10x base', () => {
    const rl = createRateLimiter(1000);
    for (let i = 0; i < 20; i++) {
      rl.onRateLimited();
    }
    expect(rl.getDelay()).toBe(10000);
  });

  it('uses retryAfterSec when provided', () => {
    const rl = createRateLimiter(1000);
    rl.onRateLimited(30);
    expect(rl.getDelay()).toBe(1500);
  });

  // M1: rate-limiter must use logger.info, not console.log
  it('onSuccess does not call console.log when delay is reduced (M1)', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const rl = createRateLimiter(1000);
      rl.onRateLimited(); // bump delay
      for (let i = 0; i < 20; i++) rl.onSuccess(); // trigger reduction
      expect(consoleSpy).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('onRateLimited does not call console.log (M1)', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const rl = createRateLimiter(500);
      rl.onRateLimited(5);
      expect(consoleSpy).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('resets consecutive successes on rate limit', () => {
    const rl = createRateLimiter(2000);
    for (let i = 0; i < 19; i++) {
      rl.onSuccess();
    }
    rl.onRateLimited();
    // 19 successes, then rate limit resets counter; 20 more successes needed now
    for (let i = 0; i < 19; i++) {
      rl.onSuccess();
    }
    // Still at increased delay since we haven't hit 20 yet
    expect(rl.getDelay()).toBe(3000);
  });

  it('wait resolves', async () => {
    const rl = createRateLimiter(100);
    const promise = rl.wait();
    await vi.advanceTimersByTimeAsync(200);
    await promise;
  });
});

describe('retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns immediately on success', async () => {
    const result = await retry(async () => 42, { maxRetries: 3 });
    expect(result).toBe(42);
  });

  it('retries and succeeds', async () => {
    let attempt = 0;
    const promise = retry(
      async () => {
        attempt++;
        if (attempt < 3) throw new Error('fail');
        return 'ok';
      },
      { maxRetries: 3, baseDelay: 100 },
    );

    // Advance through retry delays
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;
    expect(result).toBe('ok');
    expect(attempt).toBe(3);
  });

  it('throws after exhausting retries', async () => {
    const promise = retry(
      async () => {
        throw new Error('always fails');
      },
      { maxRetries: 2, baseDelay: 100 },
    );

    // Attach a catch to prevent unhandled rejection warning
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(10000);
    await expect(promise).rejects.toThrow('always fails');
  });

  it('calls onRetry callback', async () => {
    const onRetry = vi.fn();
    let attempt = 0;
    const promise = retry(
      async () => {
        attempt++;
        if (attempt < 2) throw new Error('fail');
        return 'ok';
      },
      { maxRetries: 3, baseDelay: 100, onRetry },
    );

    await vi.advanceTimersByTimeAsync(5000);
    await promise;
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error));
  });
});

describe('createProgressTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2024-01-01T12:00:00') });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('tracks stats correctly', () => {
    const tracker = createProgressTracker(100);
    tracker.increment();
    tracker.increment();
    tracker.incrementFailed();
    const stats = tracker.getStats();
    expect(stats.scraped).toBe(2);
    expect(stats.failed).toBe(1);
    expect(stats.total).toBe(100);
  });

  it('report returns formatted string', () => {
    const tracker = createProgressTracker(100);
    vi.advanceTimersByTime(1000);
    tracker.increment();
    const report = tracker.report();
    expect(report).toContain('1');
    expect(report).toContain('100');
    expect(report).toContain('1.0%');
    expect(report).toContain('Failed: 0');
  });

  it('report handles zero total', () => {
    const tracker = createProgressTracker(0);
    const report = tracker.report();
    expect(report).toContain('0.0%');
  });

  it('report shows hours for long durations', () => {
    const tracker = createProgressTracker(1000);
    vi.advanceTimersByTime(3600 * 1000); // 1 hour
    tracker.increment();
    const report = tracker.report();
    expect(report).toContain('h');
  });

  it('report shows minutes for moderate durations', () => {
    const tracker = createProgressTracker(100);
    vi.advanceTimersByTime(120 * 1000); // 2 minutes
    tracker.increment();
    const report = tracker.report();
    expect(report).toContain('m');
  });
});

describe('createShutdownHandler', () => {
  it('isShuttingDown defaults to false', () => {
    const handler = createShutdownHandler();
    expect(handler.isShuttingDown()).toBe(false);
  });

  it('registers callbacks', () => {
    const handler = createShutdownHandler();
    const cb = vi.fn();
    handler.onShutdown(cb);
    // callback is stored but not called yet
    expect(cb).not.toHaveBeenCalled();
  });

  it('setup registers process handlers', () => {
    const handler = createShutdownHandler();
    const onSpy = vi.spyOn(process, 'on').mockImplementation(() => process);
    handler.setup();
    expect(onSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    onSpy.mockRestore();
  });

  it('sets shuttingDown on signal and calls callbacks', async () => {
    const handler = createShutdownHandler();
    let sigintHandler: (() => Promise<void>) | undefined;
    const onSpy = vi.spyOn(process, 'on').mockImplementation((event, fn) => {
      if (event === 'SIGINT') sigintHandler = fn as () => Promise<void>;
      return process;
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const cb = vi.fn();
    handler.onShutdown(cb);
    handler.setup();

    expect(handler.isShuttingDown()).toBe(false);
    await sigintHandler!();
    expect(handler.isShuttingDown()).toBe(true);
    expect(cb).toHaveBeenCalled();

    // Double signal forces exit
    await sigintHandler!();
    expect(exitSpy).toHaveBeenCalledWith(1);

    onSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
