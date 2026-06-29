import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { enqueueEmail, startEmailWorker, stopEmailQueue } from '~/server/utils/emailQueue'
import { sendEmail } from '~/server/email/send'
import { captureServerError } from '~/server/utils/observability'

// vi.mock factories are hoisted above module scope — share the spies via vi.hoisted.
// ioredis/bullmq are newed with `new`, so the mocks must be real constructors (classes).
const { queueAdd, workerCtor, redisCtor } = vi.hoisted(() => ({
  queueAdd: vi.fn().mockResolvedValue(undefined),
  workerCtor: vi.fn(),
  redisCtor: vi.fn(),
}))

vi.mock('ioredis', () => ({
  default: class {
    constructor(url: string, options: unknown) {
      redisCtor(url, options)
    }
    on = vi.fn()
    quit = vi.fn().mockResolvedValue(undefined)
    disconnect = vi.fn()
    removeAllListeners = vi.fn()
  },
}))
vi.mock('bullmq', () => ({
  Queue: class {
    add = queueAdd
    on = vi.fn()
    close = vi.fn().mockResolvedValue(undefined)
  },
  Worker: class {
    constructor() {
      workerCtor()
    }
    on = vi.fn()
    close = vi.fn().mockResolvedValue(undefined)
    removeAllListeners = vi.fn()
  },
}))
vi.mock('~/server/email/send', () => ({ sendEmail: vi.fn().mockResolvedValue(undefined) }))
vi.mock('~/server/utils/observability', () => ({
  captureServerError: vi.fn(),
  addServerBreadcrumb: vi.fn(),
}))

const origRedis = process.env.REDIS_URL
const tick = () => new Promise(r => setImmediate(r))

afterEach(async () => {
  await stopEmailQueue()
  vi.clearAllMocks()
  if (origRedis === undefined) delete process.env.REDIS_URL
  else process.env.REDIS_URL = origRedis
})

describe('enqueueEmail without Redis (inline fallback)', () => {
  beforeEach(() => {
    delete process.env.REDIS_URL
  })

  it('awaits the send for must-deliver mail', async () => {
    await enqueueEmail({ recipient: 'a@x.cz', templateKey: 'resetPassword' } as never, { mustDeliver: true })
    expect(sendEmail).toHaveBeenCalledOnce()
  })

  it('dedupes a repeated key within the window', async () => {
    const input = { recipient: 'a@x.cz', templateKey: 'x' } as never
    await enqueueEmail(input, { mustDeliver: true, dedupKey: 'eq-dedup-1' })
    await enqueueEmail(input, { mustDeliver: true, dedupKey: 'eq-dedup-1' })
    expect(sendEmail).toHaveBeenCalledOnce()
  })

  it('fire-and-forgets non-critical mail off the request thread', async () => {
    // enqueueEmail returns without awaiting the send (fireAndForgetSend is void); the send is
    // dispatched through the bounded fallback limiter and completes on a later tick.
    await enqueueEmail({ recipient: 'a@x.cz', templateKey: 'x' } as never)
    await tick()
    expect(sendEmail).toHaveBeenCalledOnce()
  })
})

describe('enqueueEmail with Redis', () => {
  beforeEach(() => {
    process.env.REDIS_URL = 'redis://localhost:6379'
  })

  it('adds a deduped job to the queue instead of sending inline', async () => {
    await enqueueEmail({ recipient: 'a@x.cz', templateKey: 'x' } as never, { dedupKey: 'eq-job-1' })
    expect(queueAdd).toHaveBeenCalledWith(
      'send',
      expect.anything(),
      expect.objectContaining({ jobId: 'eq-job-1', attempts: 5 }),
    )
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('startEmailWorker constructs a BullMQ worker', () => {
    startEmailWorker()
    expect(workerCtor).toHaveBeenCalled()
  })

  it('configures an exponential-capped retryStrategy on the connection', async () => {
    await enqueueEmail({ recipient: 'a@x.cz', templateKey: 'x' } as never, { dedupKey: 'eq-retry-1' })
    expect(redisCtor).toHaveBeenCalledWith('redis://localhost:6379', expect.anything())
    const options = redisCtor.mock.calls[0]?.[1] as { retryStrategy: (times: number) => number }
    expect(options.retryStrategy(1)).toBe(200)
    expect(options.retryStrategy(20)).toBe(2000)
  })

  it('falls back through label when q.add rejects with no templateKey', async () => {
    queueAdd.mockRejectedValueOnce(new Error('redis hiccup'))
    await enqueueEmail({ recipient: 'a@x.cz', label: 'newsletter' } as never)
    // catch-path tags resolved via input.label, then fire-and-forget runs the send.
    await tick()
    expect(captureServerError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ area: 'email.enqueue', tags: { templateKey: 'newsletter' } }),
    )
    expect(sendEmail).toHaveBeenCalledOnce()
  })

  it("tags the 'rendered' fallback when q.add rejects with neither templateKey nor label", async () => {
    queueAdd.mockRejectedValueOnce(new Error('redis hiccup'))
    await enqueueEmail({ recipient: 'a@x.cz' } as never)
    await tick()
    expect(captureServerError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ area: 'email.enqueue', tags: { templateKey: 'rendered' } }),
    )
    expect(sendEmail).toHaveBeenCalledOnce()
  })
})

describe('enqueueEmail fallback dedup cleanup', () => {
  beforeEach(() => {
    delete process.env.REDIS_URL
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const base = new Date('2099-01-01T00:00:00Z').getTime()
  const at = (deltaMs: number) => vi.setSystemTime(new Date(base + deltaMs))

  it('prunes only expired dedup entries when the cleanup interval elapses', async () => {
    // Fixed point far past any real-time lastDedupCleanup left by earlier tests, so the
    // cleanup-interval gate fires deterministically on our seeded entries.
    // T0: seed the stale entry (expires at T0 + 5min). First call also runs cleanup on the
    // empty map and stamps lastDedupCleanup = T0.
    at(0)
    await enqueueEmail({ recipient: 'a@x.cz', templateKey: 'x' } as never, {
      mustDeliver: true,
      dedupKey: 'eq-prune-stale',
    })

    // T0 + 30s: under the 60s interval, so no cleanup yet; seed a fresh entry (expires at
    // T0 + 5.5min) that must survive the prune to exercise the `ts < now` false branch.
    at(30_000)
    await enqueueEmail({ recipient: 'b@x.cz', templateKey: 'y' } as never, {
      mustDeliver: true,
      dedupKey: 'eq-prune-fresh',
    })
    expect(sendEmail).toHaveBeenCalledTimes(2)

    // T0 + 5min10s: past the stale TTL but before the fresh TTL, and >60s since lastDedupCleanup
    // ⇒ cleanup deletes the stale entry (ts < now true) and keeps the fresh one (ts < now false).
    at(310_000)
    await enqueueEmail({ recipient: 'c@x.cz', templateKey: 'z' } as never, {
      mustDeliver: true,
      dedupKey: 'eq-prune-trigger',
    })
    expect(sendEmail).toHaveBeenCalledTimes(3)

    // The stale key was pruned ⇒ re-claiming it sends again; the fresh key is still deduped.
    await enqueueEmail({ recipient: 'a@x.cz', templateKey: 'x' } as never, {
      mustDeliver: true,
      dedupKey: 'eq-prune-stale',
    })
    await enqueueEmail({ recipient: 'b@x.cz', templateKey: 'y' } as never, {
      mustDeliver: true,
      dedupKey: 'eq-prune-fresh',
    })
    expect(sendEmail).toHaveBeenCalledTimes(4)
  })
})
