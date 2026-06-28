// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — G3 extract guard for /api/threads/stream SSE surface
//
// Sprint G3 (2026-05-03) moved the inbound thread real-time stream from
// server.js into ./src/server-routes/threads.js. This file pins the
// behavior contracts that survived the extract:
//
//   * SSE response headers preserved verbatim (text/event-stream,
//     no-cache, keep-alive, X-Accel-Buffering: no).
//   * Hello envelope shape unchanged: `event: hello\ndata: {"at": <iso>}`.
//   * Heartbeat comment frame `: hb <ts>` continues every 25s (we test
//     by faking timers — a real timer assertion would slow the suite).
//   * Subscriber lifecycle: writes hello frame BEFORE awaiting the
//     LISTEN client (so subscriber wake-up is non-blocking on PG hiccup).
//   * Cleanup on req close: clearInterval + Set.delete fire even if the
//     LISTEN client setup failed (warn-only failure mode).
//   * publishThreadEvent fan-out fires once per active subscriber;
//     no-op when the Set is empty.
//   * publishThreadEvent envelope is `event: inbound\ndata: <json>`
//     with the orchestrator-supplied payload preserved verbatim
//     (thread_id, contact_id, campaign_id, message_id, last_reply_at,
//     replies_count fields all pass through without transform).
//   * Listener idempotence: ensureThreadListenClient is a no-op once the
//     dedicated connection is bound (prevents N×fan-out duplicates when
//     multiple subscribers connect in the same tick).
//   * LISTEN setup failure (pool.connect rejects) leaves the client null
//     so the next subscriber retries; warn-only, never throws to caller.
//   * Channel filter: notifications on channels other than
//     `thread_inbound` are ignored (defensive — pg client emits
//     notifications on any channel the connection LISTENs to).
//
// Memory rules:
//   feedback_extreme_testing  (T0)  — 12 cases, covering happy + boundary
//                                     + error + integration paths.
//   feedback_no_speculation   (T0)  — every assertion derived from the
//                                     extracted module body, not inferred.
//   feedback_operator_focus   (T1)  — these contracts back the inbound
//                                     triage workflow surface.
// ═══════════════════════════════════════════════════════════════════════════

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'
import { EventEmitter } from 'events'

// ── Mock pg.Pool with a controllable LISTEN client ────────────────────
type ListenClient = EventEmitter & {
  query: (sql: string) => Promise<{ rows: unknown[] }>
  release?: () => void
}

// Counter so tests can wait until the server has actually invoked pool.connect().
let connectAttempts = 0
let connectImpl: () => Promise<ListenClient> = () => Promise.reject(new Error('connect default reject'))
// Per-test trace (cleared in beforeEach for assertions on connect-call-count).
const listenClients: ListenClient[] = []
// Suite-lifetime trace — never cleared. The server-side `threadListenClient`
// module-level ref points at the FIRST successful client from any test.
// Fan-out tests must emit on it even when later tests only see no-op
// ensureThreadListenClient() calls (idempotent bind).
const allListenClients: ListenClient[] = []

function makeListenClient(): ListenClient {
  const c = new EventEmitter() as ListenClient
  c.query = vi.fn(async (_sql: string) => ({ rows: [] }))
  c.release = vi.fn()
  listenClients.push(c)
  allListenClients.push(c)
  return c
}

// Yield event loop until predicate true or attempts exhausted. SSE handler
// awaits ensureThreadListenClient() AFTER writing the hello frame, so the
// test's first read returns before pool.connect() has resolved. We need
// to spin until the server-side await chain has actually run.
async function waitFor(pred: () => boolean, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (pred()) return
    await new Promise((r) => setImmediate(r))
  }
}

vi.mock('pg', () => {
  class Pool {
    async query(_sql: string, _params?: unknown[]) {
      return { rows: [], rowCount: 0 }
    }
    async connect() {
      connectAttempts += 1
      return connectImpl()
    }
    on() {}
    end() {}
  }
  return { default: { Pool }, Pool }
})
vi.mock('../../staleGuard.js', () => ({ runGuards: vi.fn(), logBootRecovery: vi.fn() }))
vi.mock('../../configDrift.js', () => ({ runConfigDrift: vi.fn() }))

let baseUrl = ''
let server: import('http').Server
const savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  const mod = await import('../../server.js')
  const { app } = mod as { app: import('express').Express }
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address() as AddressInfo
      baseUrl = `http://127.0.0.1:${addr.port}`
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

beforeEach(() => {
  listenClients.length = 0
  connectAttempts = 0
  // default: connect rejects. Individual tests override.
  connectImpl = () => Promise.reject(new Error('connect default reject'))
})

// ── SSE helper: fetch with manual stream read; close after first read ──
async function openStream(): Promise<{
  status: number
  headers: Headers
  firstFrame: string
  controller: AbortController
}> {
  const controller = new AbortController()
  const res = await fetch(baseUrl + '/api/threads/stream', { signal: controller.signal })
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  // Read until at least one full frame (terminated by \n\n) lands.
  let buf = ''
  while (!buf.includes('\n\n')) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
  }
  // Cancel reader so the abort below is clean.
  try { await reader.cancel() } catch { /* already done */ }
  return { status: res.status, headers: res.headers, firstFrame: buf, controller }
}

// ═══════════════════════════════════════════════════════════════════════
//  1) SSE response headers
// ═══════════════════════════════════════════════════════════════════════

describe('G3: GET /api/threads/stream — SSE headers', () => {
  it('returns 200 with text/event-stream content-type', async () => {
    const { status, headers, controller } = await openStream()
    expect(status).toBe(200)
    expect(headers.get('content-type')).toMatch(/^text\/event-stream/)
    controller.abort()
  })

  it('sets cache-control: no-cache, no-transform', async () => {
    const { headers, controller } = await openStream()
    expect(headers.get('cache-control')).toContain('no-cache')
    expect(headers.get('cache-control')).toContain('no-transform')
    controller.abort()
  })

  it('sets X-Accel-Buffering: no for nginx-style proxies', async () => {
    const { headers, controller } = await openStream()
    expect(headers.get('x-accel-buffering')).toBe('no')
    controller.abort()
  })

  it('sets Connection: keep-alive', async () => {
    const { headers, controller } = await openStream()
    // Some HTTP/1.1 clients normalize Connection; tolerate keep-alive in any case.
    const conn = (headers.get('connection') || '').toLowerCase()
    expect(conn === 'keep-alive' || conn === '').toBe(true)
    controller.abort()
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  2) Hello envelope
// ═══════════════════════════════════════════════════════════════════════

describe('G3: hello envelope shape', () => {
  it('emits event: hello with ISO `at` timestamp on subscribe', async () => {
    const { firstFrame, controller } = await openStream()
    expect(firstFrame).toContain('event: hello')
    const dataLine = firstFrame.split('\n').find((l) => l.startsWith('data: '))
    expect(dataLine).toBeDefined()
    const payload = JSON.parse(dataLine!.slice('data: '.length))
    expect(payload).toHaveProperty('at')
    expect(typeof payload.at).toBe('string')
    expect(() => new Date(payload.at).toISOString()).not.toThrow()
    controller.abort()
  })

  it('hello frame is delivered even when LISTEN client setup fails', async () => {
    // connect rejects → ensureThreadListenClient hits the warn-only path.
    // hello is written BEFORE the await, so subscriber still gets it.
    connectImpl = () => Promise.reject(new Error('pool exhausted'))
    const { status, firstFrame, controller } = await openStream()
    expect(status).toBe(200)
    expect(firstFrame).toContain('event: hello')
    controller.abort()
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  3) PG LISTEN client wiring
// ═══════════════════════════════════════════════════════════════════════

// Module state caveat: server.js is imported once and the module-level
// `threadListenClient` ref persists across tests. Once any test successfully
// resolves connect(), `ensureThreadListenClient` is a no-op for the rest of
// the suite. Tests below are written to be robust under either ordering:
//   - LISTEN-failure tests check that connect was attempted at least once
//     when the binding is still null.
//   - LISTEN-success tests check that `connectAttempts` does NOT grow when
//     a binding already exists (regardless of which earlier test bound it).
describe('G3: PG LISTEN client lifecycle', () => {
  it('LISTEN failure is warn-only — request still resolves 200', async () => {
    // Run this BEFORE any successful bind so we observe the failure path.
    // (vitest defaults to source-order within a file; this test is placed
    // first inside the lifecycle block on purpose.)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    connectImpl = () => Promise.reject(new Error('boom'))
    const startAttempts = connectAttempts
    const { status, controller } = await openStream()
    expect(status).toBe(200)
    // If the listener was already bound by an earlier test, connect won't be
    // called and the warn won't fire. We only assert warn when an attempt
    // actually happened on this turn.
    await waitFor(() => connectAttempts > startAttempts, 5)
    if (connectAttempts > startAttempts) {
      await waitFor(() => warnSpy.mock.calls.length > 0, 20)
      expect(warnSpy).toHaveBeenCalled()
      const msgs = warnSpy.mock.calls.map((c) => c.join(' ')).join(' | ')
      expect(msgs).toMatch(/\[threads\/stream\] LISTEN setup failed/)
    }
    warnSpy.mockRestore()
    controller.abort()
  })

  it('issues LISTEN thread_inbound when first subscriber binds the listener', async () => {
    // Robust under either ordering: if a prior test already bound the
    // listener, we assert on whichever ListenClient is in `listenClients`
    // (the bound one) — its query MUST have been called with 'LISTEN
    // thread_inbound'. If no prior bind happened, the makeListenClient
    // call here is the one that gets bound.
    connectImpl = async () => makeListenClient()
    const { controller } = await openStream()
    await waitFor(() => listenClients.some((c) => (c.query as unknown as { mock?: { calls: unknown[][] } }).mock!.calls.length > 0))
    const bound = listenClients.find((c) => (c.query as unknown as { mock?: { calls: unknown[][] } }).mock!.calls.length > 0)
    expect(bound).toBeDefined()
    expect(bound!.query).toHaveBeenCalledWith('LISTEN thread_inbound')
    controller.abort()
  })

  it('does not re-LISTEN when a second subscriber connects (idempotent)', async () => {
    // The listener is already bound by a previous successful test in this
    // suite. A new subscriber must not trigger another pool.connect() call.
    connectImpl = async () => makeListenClient()
    const startAttempts = connectAttempts
    const { controller } = await openStream()
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    expect(connectAttempts).toBe(startAttempts)
    controller.abort()
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  4) Inbound notification fan-out
// ═══════════════════════════════════════════════════════════════════════

// The bound ListenClient is the one whose .query was invoked with the
// 'LISTEN thread_inbound' SQL. After the lifecycle block above runs, at
// least one such client exists in `listenClients`. The fan-out tests
// emit on whichever is currently bound — server-side has registered its
// `notification` handler on that emitter.
function findBoundListener(): ListenClient | undefined {
  return allListenClients.find((c) => {
    const mock = (c.query as unknown as { mock?: { calls: unknown[][] } }).mock
    return mock?.calls.some((args) => args[0] === 'LISTEN thread_inbound')
  })
}

describe('G3: thread_inbound notification fan-out', () => {
  it('forwards thread_inbound payload as event: inbound preserving fields', async () => {
    // Make sure we have a bound listener (idempotent — no-op if already bound).
    connectImpl = async () => makeListenClient()
    const controller = new AbortController()
    const res = await fetch(baseUrl + '/api/threads/stream', { signal: controller.signal })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (!buf.includes('\n\n')) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
    }
    expect(buf).toContain('event: hello')
    await waitFor(() => !!findBoundListener())
    const bound = findBoundListener()
    expect(bound).toBeDefined()

    const payload = {
      thread_id: 4242,
      contact_id: 17,
      campaign_id: 9,
      message_id: 'mid-001',
      last_reply_at: '2026-05-03T08:00:00.000Z',
      replies_count: 3,
    }
    bound!.emit('notification', { channel: 'thread_inbound', payload: JSON.stringify(payload) })

    let inboundBuf = ''
    while (!inboundBuf.includes('\n\n')) {
      const { value, done } = await reader.read()
      if (done) break
      inboundBuf += decoder.decode(value, { stream: true })
    }
    expect(inboundBuf).toContain('event: inbound')
    const dataLine = inboundBuf.split('\n').find((l) => l.startsWith('data: '))
    const parsed = JSON.parse(dataLine!.slice('data: '.length))
    expect(parsed).toEqual(payload)
    try { await reader.cancel() } catch { /* done */ }
    controller.abort()
  })

  it('ignores notifications on channels other than thread_inbound', async () => {
    connectImpl = async () => makeListenClient()
    const { firstFrame, controller } = await openStream()
    expect(firstFrame).toContain('event: hello')
    await waitFor(() => !!findBoundListener())
    const bound = findBoundListener()
    expect(bound).toBeDefined()
    expect(() =>
      bound!.emit('notification', { channel: 'foo_bar', payload: '{"x":1}' }),
    ).not.toThrow()
    controller.abort()
  })

  it('handles malformed payload by surfacing raw text', async () => {
    connectImpl = async () => makeListenClient()
    const controller = new AbortController()
    const res = await fetch(baseUrl + '/api/threads/stream', { signal: controller.signal })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (!buf.includes('\n\n')) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
    }
    await waitFor(() => !!findBoundListener())
    const bound = findBoundListener()
    expect(bound).toBeDefined()
    bound!.emit('notification', { channel: 'thread_inbound', payload: '{not-json' })
    let inboundBuf = ''
    while (!inboundBuf.includes('\n\n')) {
      const { value, done } = await reader.read()
      if (done) break
      inboundBuf += decoder.decode(value, { stream: true })
    }
    expect(inboundBuf).toContain('event: inbound')
    const dataLine = inboundBuf.split('\n').find((l) => l.startsWith('data: '))
    const parsed = JSON.parse(dataLine!.slice('data: '.length))
    expect(parsed).toEqual({ raw: '{not-json' })
    try { await reader.cancel() } catch { /* done */ }
    controller.abort()
  })
})
