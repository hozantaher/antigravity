// Small concurrency primitives for the batch crons. No dependency (p-limit etc.) — the codebase
// stays dependency-light, and these two shapes cover both needs: a bounded map (newsletter /
// saved-search loops) and a fire-and-forget limiter (the no-Redis email fallback).

// Run `fn` over `items` with at most `limit` tasks in flight, preserving result order by index.
// Replaces strictly-serial `for (const x of items) await fn(x)` loops without fanning out unboundedly.
// `fn` is expected to handle its own errors (the cron bodies already wrap each item in try/catch); an
// unhandled rejection propagates and rejects the whole run.
export const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (let i = cursor++; i < items.length; i = cursor++) {
      results[i] = await fn(items[i]!, i)
    }
  }
  const workerCount = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

// A bounded fire-and-forget scheduler: `schedule(task)` runs `task` when a slot frees up, never more
// than `limit` at once. Used by the no-Redis email fallback so a 500-recipient run can't detach 500
// concurrent SendGrid calls. Task errors are swallowed here (callers attach their own logging).
export const createLimiter = (limit: number): ((task: () => Promise<unknown>) => void) => {
  let active = 0
  const queue: (() => void)[] = []
  const pump = (): void => {
    while (active < limit && queue.length > 0) {
      const job = queue.shift()!
      active++
      job()
    }
  }
  return (task: () => Promise<unknown>): void => {
    queue.push(() => {
      Promise.resolve()
        .then(task)
        .catch(() => {})
        .finally(() => {
          active--
          pump()
        })
    })
    pump()
  }
}
