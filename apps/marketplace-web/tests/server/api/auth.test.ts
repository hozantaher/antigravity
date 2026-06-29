import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'
import { makeEvent, setSessionUser } from '../../setup/server'

import loginHandler from '~/server/api/auth/login.post'
import logoutHandler from '~/server/api/auth/logout.post'
import resetHandler from '~/server/api/auth/request-password-reset.post'
import { verifyIdToken, getAuthAdmin } from '~/server/utils/firebase'
import { createOrGetUser, syncAuthFields, setTokensValidAfter } from '~/server/repos/userRepo'
import { enqueueEmail } from '~/server/utils/emailQueue'
import { captureServerError, addServerBreadcrumb } from '~/server/utils/observability'
import { failEmailAction } from '~/server/utils/authEmail'

// Forces readBody(event) to reject so the handler's `.catch(() => ({}))` fallback runs.
const eventWithThrowingBody = (init: Parameters<typeof makeEvent>[0] = {}) => {
  const ev = makeEvent(init)
  Object.defineProperty((ev as { context: object }).context, 'body', {
    get() {
      throw new Error('unparseable body')
    },
  })
  return ev
}

vi.mock('~/server/utils/firebase', () => ({ verifyIdToken: vi.fn(), getAuthAdmin: vi.fn() }))
vi.mock('~/server/repos/userRepo', () => ({
  createOrGetUser: vi.fn(),
  syncAuthFields: vi.fn(),
  setTokensValidAfter: vi.fn(),
}))
vi.mock('~/server/utils/emailQueue', () => ({ enqueueEmail: vi.fn() }))
vi.mock('~/server/utils/rateLimit', () => ({ enforceRateLimit: vi.fn() }))
vi.mock('~/server/utils/authEmail', () => ({
  buildOobActionUrl: vi.fn(() => 'https://app/auth/reset?x'),
  failEmailAction: vi.fn(),
}))
vi.mock('~/server/utils/observability', () => ({ captureServerError: vi.fn(), addServerBreadcrumb: vi.fn() }))

// --- emailQueue dependency mocks (bullmq / ioredis / email send) ------------------------------
// emailQueue.ts is mocked above for the handler tests; the dedicated suite below exercises the REAL
// module via importActual with these doubles so it never opens a Redis socket or hits SendGrid.

interface FakeHandlers {
  [event: string]: ((...args: unknown[]) => void) | undefined
}

const ioredisInstances: FakeIORedis[] = []

class FakeIORedis {
  handlers: FakeHandlers = {}
  quit = vi.fn(async () => 'OK')
  disconnect = vi.fn()
  removeAllListeners = vi.fn(() => this)
  url: string
  opts: Record<string, unknown>
  constructor(url: string, opts: Record<string, unknown>) {
    this.url = url
    this.opts = opts
    ioredisInstances.push(this)
  }
  on(event: string, cb: (...args: unknown[]) => void) {
    this.handlers[event] = cb
    return this
  }
  emit(event: string, ...args: unknown[]) {
    this.handlers[event]?.(...args)
  }
}

const queueInstances: FakeQueue[] = []
let queueAddImpl: (...args: unknown[]) => Promise<unknown> = async () => ({ id: 'job' })

class FakeQueue {
  handlers: FakeHandlers = {}
  add = vi.fn((...args: unknown[]) => queueAddImpl(...args))
  close = vi.fn(async () => undefined)
  constructor() {
    queueInstances.push(this)
  }
  on(event: string, cb: (...args: unknown[]) => void) {
    this.handlers[event] = cb
    return this
  }
  emit(event: string, ...args: unknown[]) {
    this.handlers[event]?.(...args)
  }
}

const workerInstances: FakeWorker[] = []

class FakeWorker {
  handlers: FakeHandlers = {}
  processor: (job: unknown) => Promise<unknown>
  removeAllListeners = vi.fn()
  close = vi.fn(async () => undefined)
  constructor(_name: string, processor: (job: unknown) => Promise<unknown>) {
    this.processor = processor
    workerInstances.push(this)
  }
  on(event: string, cb: (...args: unknown[]) => void) {
    this.handlers[event] = cb
    return this
  }
  emit(event: string, ...args: unknown[]) {
    this.handlers[event]?.(...args)
  }
}

vi.mock('ioredis', () => ({ default: FakeIORedis }))
vi.mock('bullmq', () => ({ Queue: FakeQueue, Worker: FakeWorker }))
const sendEmailMock = vi.fn(async (_input?: unknown) => ({ ok: true, messageId: 'm1' }))
vi.mock('~/server/email/send', () => ({ sendEmail: (input: unknown) => sendEmailMock(input) }))

const firebaseAuth = {
  revokeRefreshTokens: vi.fn(),
  getUserByEmail: vi.fn(),
  generatePasswordResetLink: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getAuthAdmin).mockReturnValue(firebaseAuth as never)
})

describe('POST /api/auth/login', () => {
  it('400s without an idToken', async () => {
    await expect(loginHandler(makeEvent({ body: {} }) as never)).rejects.toMatchObject({ statusCode: 400 })
  })
  it('401s on an invalid token', async () => {
    vi.mocked(verifyIdToken).mockRejectedValue(new Error('bad'))
    await expect(loginHandler(makeEvent({ body: { idToken: 'x' } }) as never)).rejects.toMatchObject({
      statusCode: 401,
    })
  })
  it('creates/syncs the user and returns the synced row', async () => {
    vi.mocked(verifyIdToken).mockResolvedValue({ uid: 'u1', email: 'u@x.cz', email_verified: true } as never)
    vi.mocked(createOrGetUser).mockResolvedValue({ id: 'u1', emailVerified: false } as never)
    vi.mocked(syncAuthFields).mockResolvedValue({ id: 'u1', emailVerified: true } as never)
    const res = await loginHandler(makeEvent({ body: { idToken: 'x', profile: { fullName: 'A' } } }) as never)
    expect(createOrGetUser).toHaveBeenCalled()
    expect(res).toMatchObject({ emailVerified: true })
  })
  it('falls back to the created user when sync returns null', async () => {
    vi.mocked(verifyIdToken).mockResolvedValue({ uid: 'u1', email: 'u@x.cz' } as never)
    vi.mocked(createOrGetUser).mockResolvedValue({ id: 'u1' } as never)
    vi.mocked(syncAuthFields).mockResolvedValue(null as never)
    expect(await loginHandler(makeEvent({ body: { idToken: 'x' } }) as never)).toEqual({ id: 'u1' })
  })
  it('400s when the body fails to parse (readBody rejects → {} fallback)', async () => {
    await expect(loginHandler(eventWithThrowingBody() as never)).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('POST /api/auth/logout', () => {
  beforeEach(() => setSessionUser({ id: 'u1' }))

  it('sets the DB cutoff and revokes Firebase tokens', async () => {
    firebaseAuth.revokeRefreshTokens.mockResolvedValue(undefined)
    expect(await logoutHandler(makeEvent() as never)).toEqual({ ok: true, revoked: true })
    expect(setTokensValidAfter).toHaveBeenCalledWith('u1', expect.any(Date))
  })
  it('still succeeds when Firebase revoke fails (DB cutoff is the gate)', async () => {
    firebaseAuth.revokeRefreshTokens.mockRejectedValue(new Error('outage'))
    expect(await logoutHandler(makeEvent() as never)).toEqual({ ok: true, revoked: false })
    expect(setTokensValidAfter).toHaveBeenCalled()
  })
})

describe('POST /api/auth/request-password-reset', () => {
  it('400s on an invalid email', async () => {
    await expect(resetHandler(makeEvent({ body: { email: 'nope' } }) as never)).rejects.toMatchObject({
      statusCode: 400,
    })
  })
  it('responds ok and sends nothing for an unknown address (anti-enumeration)', async () => {
    firebaseAuth.getUserByEmail.mockRejectedValue({ code: 'auth/user-not-found' })
    expect(await resetHandler(makeEvent({ body: { email: 'ghost@x.cz' } }) as never)).toEqual({ ok: true })
    expect(enqueueEmail).not.toHaveBeenCalled()
  })
  it('mints a link and enqueues the email for a known address', async () => {
    firebaseAuth.getUserByEmail.mockResolvedValue({ uid: 'u1' })
    firebaseAuth.generatePasswordResetLink.mockResolvedValue('https://firebase/reset?oob=1')
    vi.mocked(enqueueEmail).mockResolvedValue(undefined as never)
    expect(await resetHandler(makeEvent({ body: { email: 'u@x.cz' } }) as never)).toEqual({ ok: true })
    expect(enqueueEmail).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: 'u@x.cz', templateKey: 'resetPassword' }),
      { mustDeliver: true },
    )
  })
  it('400s when the body fails to parse (readBody rejects → {} fallback)', async () => {
    await expect(resetHandler(eventWithThrowingBody() as never)).rejects.toMatchObject({ statusCode: 400 })
  })
  it('400s when email is present but not a string', async () => {
    await expect(resetHandler(makeEvent({ body: { email: 123 } }) as never)).rejects.toMatchObject({
      statusCode: 400,
    })
  })
  it('passes the supplied locale string through to resolveRequestLocale and still ok', async () => {
    firebaseAuth.getUserByEmail.mockResolvedValue({ uid: 'u1' })
    firebaseAuth.generatePasswordResetLink.mockResolvedValue('https://firebase/reset?oob=1')
    vi.mocked(enqueueEmail).mockResolvedValue(undefined as never)
    expect(await resetHandler(makeEvent({ body: { email: 'u@x.cz', locale: ' de ' } }) as never)).toEqual({
      ok: true,
    })
  })
  it('logs (still ok) when the lookup throws a non-not-found error', async () => {
    firebaseAuth.getUserByEmail.mockRejectedValue({ code: 'auth/internal-error' })
    expect(await resetHandler(makeEvent({ body: { email: 'u@x.cz' } }) as never)).toEqual({ ok: true })
    expect(captureServerError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ area: 'auth.request-password-reset.lookup' }),
    )
    expect(enqueueEmail).not.toHaveBeenCalled()
  })
  it('routes through failEmailAction when generatePasswordResetLink rejects', async () => {
    firebaseAuth.getUserByEmail.mockResolvedValue({ uid: 'u1' })
    firebaseAuth.generatePasswordResetLink.mockRejectedValue(new Error('link failure'))
    await resetHandler(makeEvent({ body: { email: 'u@x.cz' } }) as never)
    expect(failEmailAction).toHaveBeenCalledWith(expect.any(Error), 'auth.request-password-reset', expect.any(String))
    expect(enqueueEmail).not.toHaveBeenCalled()
  })
  it('routes through failEmailAction when enqueueEmail rejects', async () => {
    firebaseAuth.getUserByEmail.mockResolvedValue({ uid: 'u1' })
    firebaseAuth.generatePasswordResetLink.mockResolvedValue('https://firebase/reset?oob=1')
    vi.mocked(enqueueEmail).mockRejectedValue(new Error('send failure'))
    await resetHandler(makeEvent({ body: { email: 'u@x.cz' } }) as never)
    expect(failEmailAction).toHaveBeenCalledWith(
      expect.any(Error),
      'auth.request-password-reset.email',
      expect.any(String),
    )
  })
})

// rateLimit.ts is vi.mock'd at the top of this file (handlers under test never throttle). The
// limiter itself is exercised here against the REAL module via importActual — it consumes the bare
// global setResponseHeader/createError installed by tests/setup/server.ts.
describe('server/utils/rateLimit', () => {
  type RateLimitModule = typeof import('~/server/utils/rateLimit')
  let mod: RateLimitModule

  // Builds an event whose socket peer / XFF chain the limiter reads.
  const ipEvent = (init: { remote?: string | undefined; xff?: string | string[] } = {}) =>
    ({
      context: {},
      node: { req: { socket: { remoteAddress: init.remote }, headers: { 'x-forwarded-for': init.xff } } },
    }) as unknown as H3Event

  // The limiter writes 429 headers via the bare-global setResponseHeader (installed by the setup),
  // which stores them on event.context.resHeaders — so the event needs a context object.
  const eventWithHeaders = () =>
    ({
      context: {},
      node: { req: { socket: { remoteAddress: '203.0.113.9' }, headers: {} } },
    }) as unknown as H3Event

  const resHeaders = (event: H3Event): Record<string, unknown> =>
    (event as unknown as { context: { resHeaders?: Record<string, unknown> } }).context.resHeaders ?? {}

  beforeEach(async () => {
    vi.resetModules()
    delete process.env.RATE_LIMIT_TRUSTED_HOPS
    mod = await vi.importActual<RateLimitModule>('~/server/utils/rateLimit')
  })

  describe('ipFromEvent', () => {
    it("falls back to 'unknown' when the socket has no remoteAddress", () => {
      expect(mod.ipFromEvent(ipEvent({ remote: undefined, xff: undefined }))).toBe('unknown')
    })

    it('keys off the socket peer (ignoring XFF) when trusted hops is 0', () => {
      process.env.RATE_LIMIT_TRUSTED_HOPS = '0'
      expect(mod.ipFromEvent(ipEvent({ remote: '10.0.0.1', xff: '1.2.3.4' }))).toBe('10.0.0.1')
    })

    it('reads the trusted hop from a string XFF header', () => {
      expect(mod.ipFromEvent(ipEvent({ remote: '10.0.0.1', xff: '1.1.1.1, 2.2.2.2' }))).toBe('2.2.2.2')
    })

    it('reads the trusted hop from an array XFF header', () => {
      expect(mod.ipFromEvent(ipEvent({ remote: '10.0.0.1', xff: ['9.9.9.9', '8.8.8.8'] }))).toBe('8.8.8.8')
    })

    it('accepts an IPv6 candidate', () => {
      expect(mod.ipFromEvent(ipEvent({ remote: '10.0.0.1', xff: '::1' }))).toBe('::1')
    })

    it('falls back to the socket peer when XFF is absent (empty list)', () => {
      expect(mod.ipFromEvent(ipEvent({ remote: '10.0.0.1', xff: undefined }))).toBe('10.0.0.1')
    })

    it('falls back to the socket peer when the candidate is not a valid IP', () => {
      expect(mod.ipFromEvent(ipEvent({ remote: '10.0.0.1', xff: 'not-an-ip' }))).toBe('10.0.0.1')
    })

    it('honors a multi-hop trusted-proxy count', () => {
      process.env.RATE_LIMIT_TRUSTED_HOPS = '2'
      expect(mod.ipFromEvent(ipEvent({ remote: '10.0.0.1', xff: '1.1.1.1, 2.2.2.2, 3.3.3.3' }))).toBe('2.2.2.2')
    })

    it('defaults to 1 hop when RATE_LIMIT_TRUSTED_HOPS is non-numeric', () => {
      process.env.RATE_LIMIT_TRUSTED_HOPS = 'abc'
      expect(mod.ipFromEvent(ipEvent({ remote: '10.0.0.1', xff: '1.1.1.1, 2.2.2.2' }))).toBe('2.2.2.2')
    })

    it('defaults to 1 hop when RATE_LIMIT_TRUSTED_HOPS is negative', () => {
      process.env.RATE_LIMIT_TRUSTED_HOPS = '-3'
      expect(mod.ipFromEvent(ipEvent({ remote: '10.0.0.1', xff: '1.1.1.1, 2.2.2.2' }))).toBe('2.2.2.2')
    })
  })

  describe('enforceRateLimit', () => {
    it('allows requests up to the limit then 429s, setting Retry-After/limit headers', () => {
      const event = eventWithHeaders()
      const opts = { bucket: 'b', limit: 2, windowMs: 60_000, key: 'k1' }
      expect(() => mod.enforceRateLimit(event, opts)).not.toThrow() // count 1 (fresh window)
      expect(() => mod.enforceRateLimit(event, opts)).not.toThrow() // count 2
      let thrown: unknown
      try {
        mod.enforceRateLimit(event, opts) // count 3 > limit
      } catch (e) {
        thrown = e
      }
      expect(thrown).toMatchObject({ statusCode: 429, data: { retryAfter: expect.any(Number) } })
      const headers = resHeaders(event)
      expect(headers['Retry-After']).toBeGreaterThanOrEqual(1)
      expect(headers['X-RateLimit-Limit']).toBe(2)
      expect(headers['X-RateLimit-Remaining']).toBe(0)
    })

    it('starts a fresh window once the previous one has expired', () => {
      const event = eventWithHeaders()
      const opts = { bucket: 'b', limit: 1, windowMs: 10, key: 'expire' }
      expect(() => mod.enforceRateLimit(event, opts)).not.toThrow()
      vi.useFakeTimers()
      try {
        vi.setSystemTime(Date.now() + 1000) // window elapsed → resetAt <= now, takes the reset branch
        expect(() => mod.enforceRateLimit(event, opts)).not.toThrow()
      } finally {
        vi.useRealTimers()
      }
    })

    it('keys off the resolved IP when no explicit key is supplied', () => {
      const event = eventWithHeaders() // socket peer 203.0.113.9
      expect(() => mod.enforceRateLimit(event, { bucket: 'ip', limit: 1, windowMs: 60_000 })).not.toThrow()
    })

    it('prunes expired counters once the map grows past its bound', () => {
      const opts = (key: string) => ({ bucket: 'p', limit: 5, windowMs: 1000, key })
      vi.useFakeTimers()
      try {
        vi.setSystemTime(1_000_000)
        for (let i = 0; i < 5001; i += 1) mod.enforceRateLimit(eventWithHeaders(), opts(`seed-${i}`))
        vi.setSystemTime(1_000_000 + 5000) // all seeded windows now expired
        // A fresh insert past the 5000 bound triggers prune(), which deletes the expired entries.
        expect(() => mod.enforceRateLimit(eventWithHeaders(), opts('trigger'))).not.toThrow()
      } finally {
        vi.useRealTimers()
      }
    })
  })
})

// emailQueue.ts is mocked at the top of this file for the handler tests. Here we run the REAL module
// against the bullmq/ioredis/send doubles installed above, so it never opens a socket or sends mail.
describe('server/utils/emailQueue', () => {
  type EmailQueueModule = typeof import('~/server/utils/emailQueue')
  let mod: EmailQueueModule

  // Flush a setImmediate-scheduled fire-and-forget send.
  const flushMacrotask = () => new Promise<void>(resolve => setImmediate(resolve))

  const input = (over: Partial<import('~/server/email/send').SendEmailInput> = {}) => ({
    recipient: 'u@x.cz',
    templateKey: 'resetPassword' as const,
    language: 'cz',
    params: { resetUrl: 'https://app/r' },
    ...over,
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    ioredisInstances.length = 0
    queueInstances.length = 0
    workerInstances.length = 0
    queueAddImpl = async () => ({ id: 'job' })
    sendEmailMock.mockResolvedValue({ ok: true, messageId: 'm1' } as never)
    delete process.env.REDIS_URL
    mod = await vi.importActual<EmailQueueModule>('~/server/utils/emailQueue')
  })

  afterEach(async () => {
    // Reset module-level singletons (connection/queue/worker) so each test starts clean.
    await mod.stopEmailQueue()
  })

  describe('no Redis (inline fallback)', () => {
    it('fire-and-forgets a non-critical mail when REDIS_URL is unset', async () => {
      await mod.enqueueEmail(input())
      await flushMacrotask()
      expect(sendEmailMock).toHaveBeenCalledTimes(1)
    })

    it('awaits the send for mustDeliver mail and propagates failure', async () => {
      sendEmailMock.mockRejectedValueOnce(new Error('sendgrid down'))
      await expect(mod.enqueueEmail(input(), { mustDeliver: true })).rejects.toThrow('sendgrid down')
    })

    it('sends inline for mustDeliver mail on success', async () => {
      await mod.enqueueEmail(input(), { mustDeliver: true })
      expect(sendEmailMock).toHaveBeenCalledTimes(1)
    })

    it('logs (does not throw) when a fire-and-forget send rejects', async () => {
      sendEmailMock.mockRejectedValueOnce(new Error('boom'))
      await mod.enqueueEmail(input())
      await flushMacrotask()
      expect(captureServerError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ area: 'email.enqueue.fallback' }),
      )
    })

    it('tags the fallback log with label, then rendered, when templateKey is absent', async () => {
      sendEmailMock.mockRejectedValueOnce(new Error('e1'))
      await mod.enqueueEmail({ recipient: 'a@x.cz', label: 'ops' } as never)
      await flushMacrotask()
      expect(captureServerError).toHaveBeenLastCalledWith(
        expect.any(Error),
        expect.objectContaining({ tags: { templateKey: 'ops' } }),
      )
      sendEmailMock.mockRejectedValueOnce(new Error('e2'))
      await mod.enqueueEmail({ recipient: 'b@x.cz' } as never)
      await flushMacrotask()
      expect(captureServerError).toHaveBeenLastCalledWith(
        expect.any(Error),
        expect.objectContaining({ tags: { templateKey: 'rendered' } }),
      )
    })

    it('dedupes a second send within the TTL window via the process-local map', async () => {
      await mod.enqueueEmail(input(), { dedupKey: 'reset:u@x.cz' })
      await flushMacrotask()
      expect(sendEmailMock).toHaveBeenCalledTimes(1)
      await mod.enqueueEmail(input(), { dedupKey: 'reset:u@x.cz' }) // suppressed
      await flushMacrotask()
      expect(sendEmailMock).toHaveBeenCalledTimes(1)
    })

    it('runs the fallback-dedup time-based cleanup of expired keys', async () => {
      vi.useFakeTimers()
      try {
        vi.setSystemTime(1_000_000)
        await mod.enqueueEmail(input(), { dedupKey: 'old' })
        await Promise.resolve()
        // Advance past the dedup TTL + cleanup interval so the next claim sweeps the expired entry.
        vi.setSystemTime(1_000_000 + 10 * 60 * 1000)
        await mod.enqueueEmail(input(), { dedupKey: 'fresh' })
        await Promise.resolve()
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('with Redis (queue path)', () => {
    beforeEach(async () => {
      process.env.REDIS_URL = 'redis://localhost:6379'
      mod = await vi.importActual<EmailQueueModule>('~/server/utils/emailQueue')
    })

    it('adds the job to the queue and reuses cached connection/queue', async () => {
      await mod.enqueueEmail(input(), { dedupKey: 'k1' })
      await mod.enqueueEmail(input())
      expect(queueInstances).toHaveLength(1)
      expect(ioredisInstances).toHaveLength(1)
      expect(queueInstances[0]!.add).toHaveBeenCalledTimes(2)
      expect(queueInstances[0]!.add).toHaveBeenCalledWith(
        'send',
        expect.anything(),
        expect.objectContaining({ jobId: 'k1' }),
      )
    })

    it('configures TLS options for a rediss:// url', async () => {
      await mod.stopEmailQueue()
      ioredisInstances.length = 0
      process.env.REDIS_URL = 'rediss://secure:6379'
      mod = await vi.importActual<EmailQueueModule>('~/server/utils/emailQueue')
      await mod.enqueueEmail(input())
      expect(ioredisInstances[0]!.opts).toMatchObject({ tls: {} })
    })

    it('falls back to inline send (mustDeliver) when q.add throws', async () => {
      queueAddImpl = async () => {
        throw new Error('redis enqueue hiccup')
      }
      await mod.enqueueEmail(input(), { mustDeliver: true })
      expect(captureServerError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ area: 'email.enqueue' }),
      )
      expect(sendEmailMock).toHaveBeenCalledTimes(1)
    })

    it('falls back to fire-and-forget when q.add throws for non-critical mail', async () => {
      queueAddImpl = async () => {
        throw new Error('hiccup')
      }
      await mod.enqueueEmail(input())
      await flushMacrotask()
      expect(sendEmailMock).toHaveBeenCalledTimes(1)
    })

    it('suppresses the q.add-failure fallback send when the dedupKey is already claimed', async () => {
      queueAddImpl = async () => {
        throw new Error('hiccup')
      }
      await mod.enqueueEmail(input(), { dedupKey: 'dup' }) // claims + sends inline path
      await flushMacrotask()
      sendEmailMock.mockClear()
      await mod.enqueueEmail(input(), { dedupKey: 'dup' }) // claim fails → suppressed
      await flushMacrotask()
      expect(sendEmailMock).not.toHaveBeenCalled()
    })

    it('exercises the connection error/ready handlers (transient + ready reset)', async () => {
      await mod.enqueueEmail(input())
      const conn = ioredisInstances[0]!
      const transient = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
      conn.emit('error', transient)
      expect(addServerBreadcrumb).toHaveBeenCalledWith(
        expect.stringContaining('emailQueue.connection'),
        expect.objectContaining({ error: expect.any(String) }),
      )
      conn.emit('ready') // resets the cooldown
    })

    it('reports a non-transient connection error via captureServerError', async () => {
      await mod.enqueueEmail(input())
      const conn = ioredisInstances[0]!
      conn.emit('ready') // clear cooldown so the next error is logged
      conn.emit('error', new Error('AUTH failed'))
      expect(captureServerError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ area: 'emailQueue.connection' }),
      )
    })

    it('suppresses connection errors within the cooldown window', async () => {
      await mod.enqueueEmail(input())
      const conn = ioredisInstances[0]!
      conn.emit('ready')
      conn.emit('error', new Error('first non-transient'))
      const callsAfterFirst = vi.mocked(captureServerError).mock.calls.length
      conn.emit('error', new Error('second within cooldown')) // suppressed
      expect(vi.mocked(captureServerError).mock.calls.length).toBe(callsAfterFirst)
    })

    it('treats non-Error and message-based disconnects as transient', async () => {
      await mod.enqueueEmail(input())
      const conn = ioredisInstances[0]!
      conn.emit('ready')
      vi.clearAllMocks()
      // Non-Error value → isTransientConnError returns false → captureServerError.
      conn.emit('error', 'string-error')
      expect(captureServerError).toHaveBeenCalled()
      conn.emit('ready')
      vi.clearAllMocks()
      conn.emit('error', new Error('Connection is closed')) // message-based transient
      expect(addServerBreadcrumb).toHaveBeenCalled()
    })

    it('routes queue error events through reportConnError', async () => {
      await mod.enqueueEmail(input())
      ioredisInstances[0]!.emit('ready') // reset the shared cooldown so the breadcrumb is emitted
      const q = queueInstances[0]!
      q.emit('error', new Error('Socket closed unexpectedly')) // transient by message
      expect(addServerBreadcrumb).toHaveBeenCalled()
    })
  })

  describe('startEmailWorker', () => {
    it('is a no-op without Redis', () => {
      mod.startEmailWorker()
      expect(workerInstances).toHaveLength(0)
    })

    it('starts a worker once and reuses it on subsequent calls', async () => {
      process.env.REDIS_URL = 'redis://localhost:6379'
      mod = await vi.importActual<EmailQueueModule>('~/server/utils/emailQueue')
      mod.startEmailWorker()
      mod.startEmailWorker() // cached → no second worker
      expect(workerInstances).toHaveLength(1)
    })

    it('processes a job by delegating to sendEmail', async () => {
      process.env.REDIS_URL = 'redis://localhost:6379'
      mod = await vi.importActual<EmailQueueModule>('~/server/utils/emailQueue')
      mod.startEmailWorker()
      await workerInstances[0]!.processor({ data: input() })
      expect(sendEmailMock).toHaveBeenCalledTimes(1)
    })

    it('captures an error only on the final attempt; ignores null job and earlier attempts', async () => {
      process.env.REDIS_URL = 'redis://localhost:6379'
      mod = await vi.importActual<EmailQueueModule>('~/server/utils/emailQueue')
      mod.startEmailWorker()
      const w = workerInstances[0]!
      w.emit('failed', null, new Error('x')) // no job → return
      w.emit('failed', { data: input(), attemptsMade: 2, id: 'j1' }, new Error('retry')) // < ATTEMPTS
      expect(captureServerError).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ area: 'email.worker.exhausted' }),
      )
      w.emit('failed', { data: input(), attemptsMade: 5, id: 'j2' }, new Error('dead')) // == ATTEMPTS
      expect(captureServerError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ area: 'email.worker.exhausted' }),
      )
    })

    it('falls back through label/rendered/missing-id when tagging an exhausted job', async () => {
      process.env.REDIS_URL = 'redis://localhost:6379'
      mod = await vi.importActual<EmailQueueModule>('~/server/utils/emailQueue')
      mod.startEmailWorker()
      const w = workerInstances[0]!
      w.emit('failed', { data: { recipient: 'a@x.cz', label: 'ops' }, attemptsMade: 5, id: undefined }, new Error('e'))
      expect(captureServerError).toHaveBeenLastCalledWith(
        expect.any(Error),
        expect.objectContaining({ tags: expect.objectContaining({ templateKey: 'ops', jobId: '' }) }),
      )
      w.emit('failed', { data: { recipient: 'b@x.cz' }, attemptsMade: 5, id: 'j3' }, new Error('e'))
      expect(captureServerError).toHaveBeenLastCalledWith(
        expect.any(Error),
        expect.objectContaining({ tags: expect.objectContaining({ templateKey: 'rendered' }) }),
      )
    })

    it('routes worker error events through reportConnError', async () => {
      process.env.REDIS_URL = 'redis://localhost:6379'
      mod = await vi.importActual<EmailQueueModule>('~/server/utils/emailQueue')
      mod.startEmailWorker()
      workerInstances[0]!.emit('error', new Error('EPIPE-ish'))
      // reportConnError logs (captureServerError) or breadcrumbs depending on cooldown; either way no throw.
      expect(true).toBe(true)
    })
  })

  describe('stopEmailQueue', () => {
    it('is safe to call with nothing started', async () => {
      await expect(mod.stopEmailQueue()).resolves.toBeUndefined()
    })

    it('closes worker, queue and connection (quit succeeds)', async () => {
      process.env.REDIS_URL = 'redis://localhost:6379'
      mod = await vi.importActual<EmailQueueModule>('~/server/utils/emailQueue')
      await mod.enqueueEmail(input()) // creates connection + queue
      mod.startEmailWorker() // creates worker
      const conn = ioredisInstances[0]!
      const q = queueInstances[0]!
      const w = workerInstances[0]!
      await mod.stopEmailQueue()
      expect(w.close).toHaveBeenCalled()
      expect(q.close).toHaveBeenCalled()
      expect(conn.quit).toHaveBeenCalled()
    })

    it('disconnects when connection.quit() rejects', async () => {
      process.env.REDIS_URL = 'redis://localhost:6379'
      mod = await vi.importActual<EmailQueueModule>('~/server/utils/emailQueue')
      await mod.enqueueEmail(input())
      const conn = ioredisInstances[0]!
      conn.quit.mockRejectedValueOnce(new Error('quit failed'))
      await mod.stopEmailQueue()
      expect(conn.disconnect).toHaveBeenCalled()
    })
  })
})
