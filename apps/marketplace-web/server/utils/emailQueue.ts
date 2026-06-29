import { Queue, Worker, type Job } from 'bullmq'
import IORedis, { type Redis as IORedisClient } from 'ioredis'
import { sendEmail, type SendEmailInput } from '../email/send'
import { createLimiter } from './concurrency'
import { addServerBreadcrumb, captureServerError } from './observability'

// BullMQ + Redis; without REDIS_URL degrades to inline sendEmail().

const QUEUE_NAME = 'email'

// Past 5 retries the recipient is almost certainly invalid; further retries waste quota.
const ATTEMPTS = 5
const WORKER_CONCURRENCY = 5

let queue: Queue<SendEmailInput> | null = null
let worker: Worker<SendEmailInput> | null = null
let connection: IORedisClient | null = null

// ECONNRESET / idle socket resets are normal churn — ioredis reconnects itself.
// Log them as breadcrumbs, not errors, and the cooldown collapses the three-way
// fan-out (connection + queue + worker all emit one reset) into one log.
const TRANSIENT_CONN_CODES = new Set(['ECONNRESET', 'EPIPE'])
const CONN_ERROR_COOLDOWN_MS = 60_000
let lastConnErrorLoggedAt = 0

const isTransientConnError = (err: unknown): boolean => {
  if (!(err instanceof Error)) return false
  const code = (err as { code?: string }).code
  if (code && TRANSIENT_CONN_CODES.has(code)) return true
  return err.message.includes('Connection is closed') || err.message.includes('Socket closed unexpectedly')
}

const reportConnError = (err: unknown, area: string): void => {
  const now = Date.now()
  if (now - lastConnErrorLoggedAt < CONN_ERROR_COOLDOWN_MS) return
  lastConnErrorLoggedAt = now
  if (isTransientConnError(err)) {
    addServerBreadcrumb(`${area}: transient redis disconnect`, {
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }
  captureServerError(err, { area })
}

// Separate ioredis client: BullMQ blocking polls require maxRetriesPerRequest=null.
const getConnection = (): IORedisClient | null => {
  if (connection) return connection
  const url = process.env.REDIS_URL
  if (!url) return null

  const isTls = url.startsWith('rediss://')
  connection = new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: times => Math.min(times * 200, 2000),
    // rediss:// must verify the server cert — keep the default (rejectUnauthorized:true). Disabling
    // it would defeat TLS and allow a MITM on the email queue (recipient PII, reset links).
    ...(isTls ? { tls: {} } : {}),
  })

  connection.on('error', err => reportConnError(err, 'emailQueue.connection'))
  connection.on('ready', () => {
    lastConnErrorLoggedAt = 0
  })

  return connection
}

const ensureQueue = (): Queue<SendEmailInput> | null => {
  if (queue) return queue
  const redis = getConnection()
  if (!redis) return null
  const q = new Queue<SendEmailInput>(QUEUE_NAME, { connection: redis })
  q.on('error', err => reportConnError(err, 'emailQueue.queue'))
  queue = q
  return q
}

// Sync fallback bypasses BullMQ jobId dedup; process-local map covers it.
const FALLBACK_DEDUP_TTL_MS = 5 * 60 * 1000
const FALLBACK_DEDUP_CLEANUP_THRESHOLD = 1000
const FALLBACK_DEDUP_CLEANUP_INTERVAL_MS = 60_000
const fallbackDedup = new Map<string, number>()
let lastDedupCleanup = 0

const claimFallbackDedup = (key: string): boolean => {
  const now = Date.now()
  if (
    fallbackDedup.size >= FALLBACK_DEDUP_CLEANUP_THRESHOLD ||
    now - lastDedupCleanup >= FALLBACK_DEDUP_CLEANUP_INTERVAL_MS
  ) {
    lastDedupCleanup = now
    for (const [k, ts] of fallbackDedup) {
      if (ts < now) fallbackDedup.delete(k)
    }
  }
  const existing = fallbackDedup.get(key)
  if (existing !== undefined && existing >= now) return false
  fallbackDedup.set(key, now + FALLBACK_DEDUP_TTL_MS)
  return true
}

export interface EnqueueEmailOpts {
  /** Stable key to dedupe redelivery. Same key within ~5min won't double-send. */
  dedupKey?: string
  /** Critical mail (password reset, email verification). Without a working queue, send
   *  synchronously and propagate failures to the caller instead of fire-and-forget — which
   *  would silently drop the mail on a transient SendGrid error and lock the user out. */
  mustDeliver?: boolean
}

// Bounds the no-Redis fallback at the same level as the BullMQ worker, so a batch cron (e.g. a
// 500-recipient newsletter run) can't detach hundreds of simultaneous SendGrid calls and trigger
// rate-limit/429 storms or socket exhaustion. Sends queue and drain a few at a time.
const fallbackLimiter = createLimiter(WORKER_CONCURRENCY)

// Detaches the SendGrid call from the request thread so a 503 from SendGrid
// or an idle ETIMEDOUT doesn't pin the user-facing response. Errors are logged;
// callers that need delivery confirmation must not use enqueueEmail fire-and-forget.
const fireAndForgetSend = (input: SendEmailInput): void => {
  fallbackLimiter(() =>
    sendEmail(input).catch(err =>
      captureServerError(err, {
        area: 'email.enqueue.fallback',
        tags: { templateKey: input.templateKey ?? input.label ?? 'rendered' },
      }),
    ),
  )
}

export const enqueueEmail = async (input: SendEmailInput, opts: EnqueueEmailOpts = {}): Promise<void> => {
  const q = ensureQueue()
  if (!q) {
    // No Redis — degrade to a non-blocking SendGrid call so the request thread returns.
    if (opts.dedupKey && !claimFallbackDedup(opts.dedupKey)) return
    // Critical mail can't be fire-and-forget: await the send so a failure reaches the caller.
    if (opts.mustDeliver) return void (await sendEmail(input))
    fireAndForgetSend(input)
    return
  }

  try {
    await q.add('send', input, {
      ...(opts.dedupKey ? { jobId: opts.dedupKey } : {}),
      attempts: ATTEMPTS,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    })
  } catch (err) {
    // Redis hiccup at enqueue — fall back rather than drop the mail.
    captureServerError(err, {
      area: 'email.enqueue',
      tags: { templateKey: input.templateKey ?? input.label ?? 'rendered' },
    })
    if (opts.dedupKey && !claimFallbackDedup(opts.dedupKey)) return
    if (opts.mustDeliver) return void (await sendEmail(input))
    fireAndForgetSend(input)
  }
}

export const startEmailWorker = (): void => {
  if (worker) return
  const redis = getConnection()
  if (!redis) return

  worker = new Worker<SendEmailInput>(
    QUEUE_NAME,
    async (job: Job<SendEmailInput>) => {
      await sendEmail(job.data)
    },
    {
      connection: redis,
      concurrency: WORKER_CONCURRENCY,
    },
  )

  worker.on('error', err => reportConnError(err, 'emailQueue.worker'))

  worker.on('failed', (job, err) => {
    if (!job) return
    // attemptsMade is incremented before the handler runs; >= ATTEMPTS = last try.
    if (job.attemptsMade >= ATTEMPTS) {
      captureServerError(err, {
        area: 'email.worker.exhausted',
        tags: {
          templateKey: job.data.templateKey ?? job.data.label ?? 'rendered',
          jobId: job.id ?? '',
          attemptsMade: String(job.attemptsMade),
        },
      })
    }
  })
}

export const stopEmailQueue = async (): Promise<void> => {
  if (worker) {
    worker.removeAllListeners()
    await worker.close()
    worker = null
  }
  if (queue) {
    await queue.close()
    queue = null
  }
  if (connection) {
    connection.removeAllListeners()
    try {
      await connection.quit()
    } catch {
      connection.disconnect()
    }
    connection = null
  }
}
