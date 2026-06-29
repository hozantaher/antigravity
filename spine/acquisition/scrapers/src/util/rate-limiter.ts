// M-S3 SCALE WARNING (2026-04-22 audit):
// `lastRun` is an in-process Map — it is NOT shared across worker replicas.
// When concurrency > 1 or HPA scales to multiple pods, each replica maintains
// its own map, so two replicas can hit the same domain simultaneously without
// either seeing the other's timestamp. This is safe for the current single-
// replica BullMQ worker (concurrency: 1) but will silently break rate limiting
// under horizontal scaling.
//
// Upgrade path: replace with a Redis-backed token bucket using the ioredis
// connection already available in scrape-queue.ts before enabling HPA.
// Until then, do NOT increase scrape-worker concurrency > 1.
const lastRun = new Map<string, number>();

/** Minimum inter-request interval in milliseconds. */
export const MIN_INTERVAL_MS = 2000;

/**
 * Enforce a minimum inter-request interval per domain.
 * If the domain was hit less than MIN_INTERVAL_MS ago, waits for the remainder.
 *
 * NOTE: In-process only — not safe under horizontal scaling. See M-S3 warning above.
 */
export async function rateLimit(domain: string): Promise<void> {
  const last = lastRun.get(domain) ?? 0;
  const wait = MIN_INTERVAL_MS - (Date.now() - last);
  if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
  lastRun.set(domain, Date.now());
}

/** Exposed for testing only — resets internal state. */
export function _resetForTest(): void {
  lastRun.clear();
}

/** Exposed for testing only — returns the stored last-run timestamp for a domain. */
export function _getLastRun(domain: string): number | undefined {
  return lastRun.get(domain);
}
