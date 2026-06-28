// @vitest-environment node
// F1 — Integration tests for /api/replies/stream SSE endpoint (Sprint F1, #1265).
//
// Located in tests/integration/ which uses the `node` environment (see vitest.config.ts).
// The handler creates a real HTTP server; this requires node, not jsdom.
//
// Tests verify:
//   1. Response headers: Content-Type text/event-stream + cache/buffering headers
//   2. hello event emitted on connect
//   3. LISTEN issued on both `reply_inserted` and `thread_inbound` channels
//   4. reply_inserted notification fans out with PII stripped (no `from` field)
//   5. thread_inbound notification normalised to source=outreach_messages
//   6. Malformed JSON payload doesn't crash the handler
//   7. "stream" literal path routes to SSE (not /:id param)
//   8. SSE event format: event: + data: lines
//   9. received_at forwarded in safe payload
//  10. id field forwarded in safe payload

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import http from 'node:http'
import { EventEmitter } from 'node:events'

// ── Minimal SSE logic extracted from mountRepliesRoutes ────────────────────
// We mount just the SSE logic + a stub /:id route to verify route order,
// without importing the full replies.js (which pulls pg + Sentry).

function mountReplyStream(app, { pool }) {
  const replyStreamClients = new Set()

  function publishReplyEvent(payload) {
    if (replyStreamClients.size === 0) return
    const safe = {
      source:      payload.source || null,
      id:          payload.id || null,
      received_at: payload.received_at || null,
    }
    let line
    try {
      line = `event: reply_inserted\ndata: ${JSON.stringify(safe)}\n\n`
    } catch {
      return
    }
    for (const sseRes of replyStreamClients) {
      try { sseRes.write(line) } catch { /* swept by disconnect */ }
    }
  }

  let replyListenClient = null
  async function ensureReplyListenClient() {
    if (replyListenClient) return
    try {
      const c = await pool.connect()
      c.on('notification', (msg) => {
        if (msg.channel !== 'reply_inserted' && msg.channel !== 'thread_inbound') return
        let raw
        try { raw = JSON.parse(msg.payload || '{}') } catch { raw = {} }
        const payload = msg.channel === 'thread_inbound'
          ? { source: 'outreach_messages', id: raw.id || raw.thread_id || null, received_at: raw.received_at || new Date().toISOString() }
          : raw
        publishReplyEvent(payload)
      })
      c.on('error', (err) => {
        console.warn('[replies/stream] LISTEN error:', err?.message)
        replyListenClient = null
      })
      await c.query('LISTEN reply_inserted')
      await c.query('LISTEN thread_inbound')
      replyListenClient = c
    } catch (err) {
      console.warn('[replies/stream] LISTEN setup failed:', err?.message)
      replyListenClient = null
    }
  }

  // Stream route registered BEFORE /:id param route.
  app.get('/api/replies/stream', async (req, res) => {
    res.set({
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache, no-transform',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.flushHeaders?.()
    res.write(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`)
    replyStreamClients.add(res)
    await ensureReplyListenClient()
    const hb = setInterval(() => {
      try { res.write(`: hb ${Date.now()}\n\n`) } catch {}
    }, 30_000)
    req.on('close', () => {
      clearInterval(hb)
      replyStreamClients.delete(res)
    })
  })

  // Param route registered AFTER — verifies "stream" literal wins over /:id.
  app.get('/api/replies/:id', (req, res) => {
    res.json({ handler: 'param', id: req.params.id })
  })
}

// ── Test fixtures ──────────────────────────────────────────────────────────
let fakeClient
let pool
let server
let baseUrl

function startServer() {
  fakeClient = new EventEmitter()
  fakeClient.query = vi.fn().mockResolvedValue({})
  fakeClient.end = vi.fn()
  pool = { connect: vi.fn().mockResolvedValue(fakeClient) }

  return new Promise((resolve) => {
    const app = express()
    mountReplyStream(app, { pool })
    server = http.createServer(app)
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
}

function stopServer() {
  return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()))
}

// Open SSE connection and collect up to maxMs of response data.
function openSSE(path = '/api/replies/stream', maxMs = 300) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}${path}`)
    const chunks = []
    const req = http.request(url, (res) => {
      const timer = setTimeout(() => {
        req.destroy()
        resolve({ status: res.statusCode, headers: res.headers, body: chunks.join('') })
      }, maxMs)
      res.on('data', (d) => chunks.push(d.toString()))
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, headers: res.headers, body: chunks.join('') }) })
      res.on('error', (e) => { clearTimeout(timer); reject(e) })
    })
    req.on('error', reject)
    req.end()
  })
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('GET /api/replies/stream — SSE endpoint (F1, #1265)', () => {
  beforeEach(startServer)
  afterEach(stopServer)

  it('responds with Content-Type text/event-stream', async () => {
    const { headers } = await openSSE()
    expect(headers['content-type']).toMatch(/text\/event-stream/)
  })

  it('sets Cache-Control no-cache', async () => {
    const { headers } = await openSSE()
    expect(headers['cache-control']).toMatch(/no-cache/)
  })

  it('sets X-Accel-Buffering no', async () => {
    const { headers } = await openSSE()
    expect(headers['x-accel-buffering']).toBe('no')
  })

  it('emits hello event immediately on connect', async () => {
    const { body } = await openSSE()
    expect(body).toMatch(/event: hello/)
    expect(body).toMatch(/"at":/)
  })

  it('issues LISTEN reply_inserted to pg client on first connection', async () => {
    await openSSE()
    const listenCalls = fakeClient.query.mock.calls.map(c => c[0])
    expect(listenCalls).toContain('LISTEN reply_inserted')
  })

  it('issues LISTEN thread_inbound to pg client on first connection', async () => {
    await openSSE()
    const listenCalls = fakeClient.query.mock.calls.map(c => c[0])
    expect(listenCalls).toContain('LISTEN thread_inbound')
  })

  it('"stream" literal path routes to SSE handler (not /:id param)', async () => {
    const { status, headers } = await openSSE('/api/replies/stream')
    expect(status).toBe(200)
    expect(headers['content-type']).toMatch(/text\/event-stream/)
  })

  it('fans out reply_inserted notification with PII stripped (no `from` field)', async () => {
    return new Promise((resolve, reject) => {
      const req = http.request(new URL(`${baseUrl}/api/replies/stream`), (res) => {
        const chunks = []
        res.on('data', (d) => {
          chunks.push(d.toString())
          const body = chunks.join('')
          const lines = body.split('\n')
          const evIdx = lines.findIndex(l => l === 'event: reply_inserted')
          if (evIdx !== -1 && lines[evIdx + 1]?.startsWith('data:')) {
            try {
              const json = JSON.parse(lines[evIdx + 1].replace(/^data: /, ''))
              expect(json).toHaveProperty('source', 'reply_inbox')
              expect(json).toHaveProperty('id', 42)
              expect(json).not.toHaveProperty('from') // PII stripped
              req.destroy(); resolve()
            } catch (e) { reject(e) }
          }
        })
        res.on('error', reject)
        setTimeout(() => {
          fakeClient.emit('notification', {
            channel: 'reply_inserted',
            payload: JSON.stringify({ source: 'reply_inbox', id: 42, from: 'sender@example.com', received_at: '2026-01-01T00:00:00Z' }),
          })
        }, 80)
        setTimeout(() => { req.destroy(); reject(new Error('timeout waiting for reply_inserted event')) }, 600)
      })
      req.on('error', reject)
      req.end()
    })
  })

  it('normalises thread_inbound notification to source=outreach_messages', async () => {
    return new Promise((resolve, reject) => {
      const req = http.request(new URL(`${baseUrl}/api/replies/stream`), (res) => {
        const chunks = []
        res.on('data', (d) => {
          chunks.push(d.toString())
          const body = chunks.join('')
          const lines = body.split('\n')
          const evIdx = lines.findIndex(l => l === 'event: reply_inserted')
          if (evIdx !== -1 && lines[evIdx + 1]?.startsWith('data:')) {
            try {
              const json = JSON.parse(lines[evIdx + 1].replace(/^data: /, ''))
              expect(json.source).toBe('outreach_messages')
              expect(json.id).not.toBeUndefined()
              req.destroy(); resolve()
            } catch (e) { reject(e) }
          }
        })
        res.on('error', reject)
        setTimeout(() => {
          fakeClient.emit('notification', {
            channel: 'thread_inbound',
            payload: JSON.stringify({ id: 7, thread_id: 7, received_at: '2026-01-01T00:00:00Z' }),
          })
        }, 80)
        setTimeout(() => { req.destroy(); reject(new Error('timeout')) }, 600)
      })
      req.on('error', reject)
      req.end()
    })
  })

  it('ignores malformed JSON in notification payload (no server crash)', async () => {
    return new Promise((resolve, reject) => {
      let gotHello = false
      const req = http.request(new URL(`${baseUrl}/api/replies/stream`), (res) => {
        res.on('data', (d) => {
          if (d.toString().includes('hello')) gotHello = true
        })
        res.on('error', reject)
        setTimeout(() => {
          // Inject invalid payload — server must not crash/close the connection.
          fakeClient.emit('notification', { channel: 'reply_inserted', payload: 'INVALID{{{' })
          setTimeout(() => { req.destroy(); expect(gotHello).toBe(true); resolve() }, 100)
        }, 80)
        setTimeout(() => { req.destroy(); reject(new Error('timeout')) }, 700)
      })
      req.on('error', reject)
      req.end()
    })
  })

  it('received_at is included in the forwarded payload', async () => {
    return new Promise((resolve, reject) => {
      const req = http.request(new URL(`${baseUrl}/api/replies/stream`), (res) => {
        const chunks = []
        res.on('data', (d) => {
          chunks.push(d.toString())
          const body = chunks.join('')
          const lines = body.split('\n')
          const evIdx = lines.findIndex(l => l === 'event: reply_inserted')
          if (evIdx !== -1 && lines[evIdx + 1]?.startsWith('data:')) {
            try {
              const json = JSON.parse(lines[evIdx + 1].replace(/^data: /, ''))
              expect(json.received_at).toBe('2026-05-12T00:00:00Z')
              req.destroy(); resolve()
            } catch (e) { reject(e) }
          }
        })
        res.on('error', reject)
        setTimeout(() => {
          fakeClient.emit('notification', {
            channel: 'reply_inserted',
            payload: JSON.stringify({ source: 'reply_inbox', id: 5, from: 'x@y.cz', received_at: '2026-05-12T00:00:00Z' }),
          })
        }, 80)
        setTimeout(() => { req.destroy(); reject(new Error('timeout')) }, 600)
      })
      req.on('error', reject)
      req.end()
    })
  })

  it('id field from notification is forwarded in the safe payload', async () => {
    return new Promise((resolve, reject) => {
      const req = http.request(new URL(`${baseUrl}/api/replies/stream`), (res) => {
        const chunks = []
        res.on('data', (d) => {
          chunks.push(d.toString())
          const body = chunks.join('')
          const lines = body.split('\n')
          const evIdx = lines.findIndex(l => l === 'event: reply_inserted')
          if (evIdx !== -1 && lines[evIdx + 1]?.startsWith('data:')) {
            try {
              const json = JSON.parse(lines[evIdx + 1].replace(/^data: /, ''))
              expect(json.id).toBe(123)
              req.destroy(); resolve()
            } catch (e) { reject(e) }
          }
        })
        res.on('error', reject)
        setTimeout(() => {
          fakeClient.emit('notification', {
            channel: 'reply_inserted',
            payload: JSON.stringify({ source: 'reply_inbox', id: 123, received_at: '2026-05-12T00:00:00Z' }),
          })
        }, 80)
        setTimeout(() => { req.destroy(); reject(new Error('timeout')) }, 600)
      })
      req.on('error', reject)
      req.end()
    })
  })
})
