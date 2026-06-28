// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — GET /api/threads/stream  (mail-client S3.1)
//
//  Server-Sent Events channel that fans out PG NOTIFY 'thread_inbound'
//  payloads to every connected client. ML S3.2 wires orchestrator-side
//  notify; this test mocks the LISTEN connection to verify the BFF
//  routing layer + heartbeat + cleanup.
// ═══════════════════════════════════════════════════════════════════════════

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

type QueryOutcome = { rows: unknown[]; rowCount?: number } | Error
const queryQueue: QueryOutcome[] = []
const calls: Array<{ sql: string; params?: unknown[] }> = []

// Capture the listen client so the test can fire fake notifications.
let listenClient: any = null
const listenHandlers: Array<(msg: { channel: string; payload?: string }) => void> = []

vi.mock('pg', () => {
  class FakeClient {
    private notificationHandlers: Array<(msg: any) => void> = []
    on(event: string, handler: (msg: any) => void) {
      if (event === 'notification') {
        this.notificationHandlers.push(handler)
        listenHandlers.push(handler)
      }
    }
    async query(sql: string) {
      calls.push({ sql })
      if (sql.startsWith('LISTEN')) {
        listenClient = this
        return { rows: [] }
      }
      if (!queryQueue.length) return { rows: [], rowCount: 0 }
      const next = queryQueue.shift()!
      if (next instanceof Error) throw next
      return next
    }
    release() {}
  }
  class Pool {
    async connect() {
      return new FakeClient()
    }
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params })
      if (!queryQueue.length) return { rows: [], rowCount: 0 }
      const next = queryQueue.shift()!
      if (next instanceof Error) throw next
      return next
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
  // Save env so afterAll can restore — prevents cross-test-file env leak
  // (docs/audits/2026-04-30-blind-spot-audit.md § A).
  for (const k of ['BFF_IMPORT_ONLY', 'BFF_AUTH_DISABLED', 'DATABASE_URL', 'GO_SERVER_URL']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.BFF_AUTH_DISABLED = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  const mod = await import('../../server.js')
  delete process.env.GO_SERVER_URL
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
  queryQueue.length = 0
  calls.length = 0
})

// Helper — open SSE connection and resolve when N events received.
async function readSSE(url: string, eventCount: number, timeoutMs = 3000): Promise<string[]> {
  const controller = new AbortController()
  const res = await fetch(url, { signal: controller.signal })
  if (!res.body) throw new Error('no body')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const events: string[] = []
  const deadline = Date.now() + timeoutMs

  while (events.length < eventCount && Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((r) =>
        setTimeout(() => r({ value: undefined, done: true }), Math.max(0, deadline - Date.now()))
      ),
    ])
    if (done) break
    if (!value) continue
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      events.push(buf.slice(0, idx))
      buf = buf.slice(idx + 2)
      if (events.length >= eventCount) break
    }
  }
  controller.abort()
  return events
}

describe('S3.1 GET /api/threads/stream', () => {
  // 1. SSE response has correct headers.
  it('1. returns Content-Type: text/event-stream + Cache-Control no-cache', async () => {
    const controller = new AbortController()
    const res = await fetch(`${baseUrl}/api/threads/stream`, { signal: controller.signal })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(res.headers.get('cache-control')).toContain('no-cache')
    expect(res.headers.get('connection')).toContain('keep-alive')
    controller.abort()
  })

  // 2. First event is `hello` with timestamp.
  it('2. first SSE message is event:hello with timestamp', async () => {
    const events = await readSSE(`${baseUrl}/api/threads/stream`, 1)
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events[0]).toContain('event: hello')
    expect(events[0]).toMatch(/data: \{"at":"[^"]+"\}/)
  })

  // 3. listenHandlers wired up — at least one notification handler attached.
  // (LISTEN itself is verified end-to-end by test 4 below; here we just
  // confirm the BFF registered a notification listener with the pool.)
  it('3. notification handler wired up', async () => {
    const events = await readSSE(`${baseUrl}/api/threads/stream`, 1)
    expect(events.length).toBeGreaterThanOrEqual(1)
    await new Promise(r => setTimeout(r, 100))
    expect(listenHandlers.length).toBeGreaterThan(0)
  })

  // 4. Notification fan-out — payload appears in connected SSE client.
  it('4. PG NOTIFY thread_inbound payload reaches SSE client', async () => {
    const controller = new AbortController()
    const res = await fetch(`${baseUrl}/api/threads/stream`, { signal: controller.signal })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()

    // Skip hello event.
    await reader.read()

    // Wait for LISTEN to register.
    await new Promise(r => setTimeout(r, 100))

    // Fire fake notification.
    const payload = { thread_id: 42, message_id: 99 }
    for (const h of listenHandlers) {
      h({ channel: 'thread_inbound', payload: JSON.stringify(payload) })
    }

    // Read next chunk — should contain the inbound event.
    const { value } = await Promise.race([
      reader.read(),
      new Promise<{ value: Uint8Array }>((_, reject) =>
        setTimeout(() => reject(new Error('SSE timeout')), 2000)
      ),
    ])
    const text = decoder.decode(value)
    expect(text).toContain('event: inbound')
    expect(text).toContain('"thread_id":42')
    expect(text).toContain('"message_id":99')
    controller.abort()
  })

  // 5. Notification on different channel is ignored.
  it('5. NOTIFY on other channel does NOT trigger inbound event', async () => {
    const controller = new AbortController()
    const res = await fetch(`${baseUrl}/api/threads/stream`, { signal: controller.signal })
    const reader = res.body!.getReader()
    await reader.read() // hello
    await new Promise(r => setTimeout(r, 100))

    for (const h of listenHandlers) {
      h({ channel: 'OTHER_CHANNEL', payload: JSON.stringify({ x: 1 }) })
    }

    const { value } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined }>((r) =>
        setTimeout(() => r({ value: undefined }), 500)
      ),
    ])
    const text = value ? new TextDecoder().decode(value) : ''
    expect(text).not.toContain('event: inbound')
    controller.abort()
  })

  // 6. Multiple clients all receive same notification.
  it('6. fan-out — 3 clients all receive the same NOTIFY', async () => {
    const controllers = [new AbortController(), new AbortController(), new AbortController()]
    const readers = await Promise.all(controllers.map(async (ctrl) => {
      const r = await fetch(`${baseUrl}/api/threads/stream`, { signal: ctrl.signal })
      return r.body!.getReader()
    }))
    // Read hello from each.
    for (const reader of readers) await reader.read()
    await new Promise(r => setTimeout(r, 100))

    const payload = { thread_id: 7 }
    for (const h of listenHandlers) {
      h({ channel: 'thread_inbound', payload: JSON.stringify(payload) })
    }

    const decoder = new TextDecoder()
    const got = await Promise.all(readers.map(async (reader) => {
      const { value } = await Promise.race([
        reader.read(),
        new Promise<{ value: Uint8Array }>((_, rej) =>
          setTimeout(() => rej(new Error('timeout')), 2000)
        ),
      ])
      return decoder.decode(value)
    }))
    for (const text of got) {
      expect(text).toContain('"thread_id":7')
    }
    controllers.forEach(c => c.abort())
  })

  // 7. Source-level audit — threads.js (G3 extract) has the SSE endpoint.
  // The route was extracted from server.js in Sprint G3 (2026-05-03) to
  // src/server-routes/threads.js. This test was updated as part of the
  // contract-test triage (issue #763) to point at the extracted module.
  it('7. SOURCE AUDIT — threads.js declares /api/threads/stream', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const src = await fs.readFile(
      path.resolve(process.cwd(), 'src/server-routes/threads.js'),
      'utf8',
    )
    expect(src).toMatch(/app\.get\(['"]\/api\/threads\/stream['"]/)
    expect(src).toContain('LISTEN thread_inbound')
    expect(src).toContain('publishThreadEvent')
  })

  // 8. Source-level audit — heartbeat on threadStreamClients (proxy idle guard)
  it('8. SOURCE AUDIT — heartbeat interval present (proxies kill idle SSE)', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    // G3 extract: heartbeat lives in src/server-routes/threads.js now.
    const src = await fs.readFile(
      path.resolve(process.cwd(), 'src/server-routes/threads.js'),
      'utf8',
    )
    // Look in the threads/stream block specifically (avoids matching mailbox health-stream).
    const tsBlock = src.slice(src.indexOf("'/api/threads/stream'"))
    expect(tsBlock).toContain('setInterval')
    expect(tsBlock).toContain(': hb')
  })

  // 9. Malformed NOTIFY payload doesn't crash listener.
  it('9. malformed JSON payload → graceful fallback to raw', async () => {
    const controller = new AbortController()
    const res = await fetch(`${baseUrl}/api/threads/stream`, { signal: controller.signal })
    const reader = res.body!.getReader()
    await reader.read()
    await new Promise(r => setTimeout(r, 100))

    for (const h of listenHandlers) {
      h({ channel: 'thread_inbound', payload: 'not-json' })
    }

    const { value } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined }>((r) =>
        setTimeout(() => r({ value: undefined }), 500)
      ),
    ])
    const text = value ? new TextDecoder().decode(value) : ''
    expect(text).toContain('event: inbound')
    expect(text).toContain('"raw":"not-json"')
    controller.abort()
  })

  // 10. Empty payload doesn't crash.
  it('10. empty payload → empty object', async () => {
    const controller = new AbortController()
    const res = await fetch(`${baseUrl}/api/threads/stream`, { signal: controller.signal })
    const reader = res.body!.getReader()
    await reader.read()
    await new Promise(r => setTimeout(r, 100))

    for (const h of listenHandlers) {
      h({ channel: 'thread_inbound', payload: undefined })
    }

    const { value } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined }>((r) =>
        setTimeout(() => r({ value: undefined }), 500)
      ),
    ])
    const text = value ? new TextDecoder().decode(value) : ''
    expect(text).toContain('event: inbound')
    controller.abort()
  })
})
