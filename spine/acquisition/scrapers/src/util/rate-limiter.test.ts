import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { rateLimit, _resetForTest, _getLastRun, MIN_INTERVAL_MS } from './rate-limiter.js';

describe('rateLimit', () => {
  beforeEach(() => {
    _resetForTest();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves immediately on first call for a domain', async () => {
    const start = Date.now();
    const promise = rateLimit('example.com');
    // Advance time so setTimeout(0) resolves — no wait expected
    vi.advanceTimersByTime(0);
    await promise;
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('records the last-run timestamp after calling', async () => {
    const before = Date.now();
    const promise = rateLimit('test.cz');
    vi.advanceTimersByTime(0);
    await promise;
    const recorded = _getLastRun('test.cz');
    expect(recorded).toBeDefined();
    expect(recorded!).toBeGreaterThanOrEqual(before);
  });

  it('waits the remaining interval when called in quick succession', async () => {
    // First call — records timestamp at t=0.
    const first = rateLimit('quick.cz');
    vi.advanceTimersByTime(0);
    await first;

    // Second call at t=500ms — should wait ~1500ms more.
    vi.advanceTimersByTime(500);

    let resolved = false;
    const second = rateLimit('quick.cz').then(() => {
      resolved = true;
    });

    // At t=500+1000=1500 — still within 2000ms window, should NOT be resolved yet.
    vi.advanceTimersByTime(1000);
    // Give microtasks a chance to settle.
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Advance past the full 2000ms window.
    vi.advanceTimersByTime(600);
    await second;
    expect(resolved).toBe(true);
  });

  it('does not enforce rate limit across different domains', async () => {
    // Saturate domain-a.
    const first = rateLimit('domain-a.cz');
    vi.advanceTimersByTime(0);
    await first;

    // domain-b should resolve immediately even though domain-a was just hit.
    let domainBResolved = false;
    const second = rateLimit('domain-b.cz').then(() => {
      domainBResolved = true;
    });
    vi.advanceTimersByTime(0);
    await second;
    expect(domainBResolved).toBe(true);
  });

  it('allows a second call after the full interval has elapsed', async () => {
    const first = rateLimit('slow.cz');
    vi.advanceTimersByTime(0);
    await first;

    // Advance by exactly 2000ms.
    vi.advanceTimersByTime(2000);

    let resolved = false;
    const second = rateLimit('slow.cz').then(() => {
      resolved = true;
    });
    vi.advanceTimersByTime(0);
    await second;
    expect(resolved).toBe(true);
  });

  // M-S3 (2026-04-22): document the in-process contract and export visibility.

  it('MIN_INTERVAL_MS is exported and equals 2000', () => {
    // Ensures the constant is accessible for upstream callers that may want to
    // back-pressure or configure their own timeouts relative to this value.
    expect(MIN_INTERVAL_MS).toBe(2000);
  });

  it('wait calculation uses MIN_INTERVAL_MS as the full window', async () => {
    // First call at t=0.
    const first = rateLimit('window-check.cz');
    vi.advanceTimersByTime(0);
    await first;

    // Advance by exactly MIN_INTERVAL_MS − 1 ms.
    vi.advanceTimersByTime(MIN_INTERVAL_MS - 1);

    let resolved = false;
    const second = rateLimit('window-check.cz').then(() => { resolved = true; });

    // Still 1 ms short of the window — should not have resolved.
    vi.advanceTimersByTime(0);
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Advance the remaining 1 ms — now it should resolve.
    vi.advanceTimersByTime(1);
    await second;
    expect(resolved).toBe(true);
  });

  it('state is isolated per domain — saturating one does not affect another', async () => {
    // Saturate domain-x at t=0.
    const a = rateLimit('domain-x.cz');
    vi.advanceTimersByTime(0);
    await a;

    // domain-y has never been called — must resolve immediately.
    let yResolved = false;
    const b = rateLimit('domain-y.cz').then(() => { yResolved = true; });
    vi.advanceTimersByTime(0);
    await b;
    expect(yResolved).toBe(true);
  });
});
