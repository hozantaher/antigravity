// BFF contract tests — GET /api/attachments/:id/blob (#874)
// ─────────────────────────────────────────────────────────────────────────────
// Verifies the attachment blob streaming endpoint introduced for inbound
// attachment display in ThreadDetail. Tests cover:
//   - Auth required (missing X-API-Key → 401)
//   - 400 on non-numeric / zero / negative id
//   - 404 when row absent
//   - Valid image blob: correct Content-Type, Content-Disposition inline, bytes
//   - Safe MIME enforcement: SVG forced to octet-stream, not served inline
//   - Safe MIME enforcement: application/pdf forced to octet-stream
//   - Content-Disposition: attachment (not inline) for non-image types
//   - Content-Length header set from size_bytes
//   - Cache-Control: private
//   - DB error → 500
//   - JPEG thumbnail served inline (primary happy path)
//   - PNG served inline
//   - attachment id carried through to query param
//
// Memory rules:
//   feedback_extreme_testing (T0) — ≥10 cases, boundary + error + integration

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

type QueryOutcome = { rows: unknown[]; rowCount?: number } | Error
const queryQueue: QueryOutcome[] = []
const calls: Array<{ sql: string; params?: unknown[] }> = []

vi.mock('pg', () => {
  class Pool {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params })
      if (!queryQueue.length) return { rows: [], rowCount: 0 }
      const next = queryQueue.shift()!
      if (next instanceof Error) throw next
      return next
    }
    async connect() {
      return {
        query: async (sql: string, params?: unknown[]) => {
          calls.push({ sql, params })
          if (!queryQueue.length) return { rows: [], rowCount: 0 }
          const next = queryQueue.shift()!
          if (next instanceof Error) throw next
          return next
        },
        release: () => {},
        on: () => {},
      }
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
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL', 'BFF_AUTH_DISABLED', 'OUTREACH_API_KEY']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  // Auth enabled — we test the 401 path explicitly.
  process.env.OUTREACH_API_KEY = 'test-key-874'
  delete process.env.BFF_AUTH_DISABLED

  vi.resetModules()
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
  queryQueue.length = 0
  calls.length = 0
  // Ensure auth middleware is active (not disabled by other test files in the same run).
  delete process.env.BFF_AUTH_DISABLED
  process.env.OUTREACH_API_KEY = 'test-key-874'
})

function q(rows: unknown[], rowCount = rows.length) {
  queryQueue.push({ rows, rowCount })
}
function qErr(msg: string) {
  queryQueue.push(new Error(msg))
}

// Minimal JPEG 1×1 pixel (valid binary)
const TINY_JPEG = Buffer.from([
  0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9,
])

// Raw HTTP helper — does NOT follow redirects, returns body as Buffer
async function getBlob(path: string, apiKey?: string) {
  const headers: Record<string, string> = {}
  if (apiKey !== undefined) headers['x-api-key'] = apiKey
  const r = await fetch(baseUrl + path, { headers })
  const buf = Buffer.from(await r.arrayBuffer())
  return { status: r.status, headers: r.headers, body: buf }
}

async function getJson(path: string, apiKey?: string) {
  const headers: Record<string, string> = {}
  if (apiKey !== undefined) headers['x-api-key'] = apiKey
  const r = await fetch(baseUrl + path, { headers })
  const text = await r.text()
  let body: unknown = text
  try { body = JSON.parse(text) } catch {}
  return { status: r.status, body }
}

const KEY = 'test-key-874'

// ─────────────────────────────────────────────────────────────────────────────
//  Auth
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/attachments/:id/blob — auth', () => {
  it('A1: missing X-API-Key → 401', async () => {
    const res = await getJson('/api/attachments/1/blob')
    expect(res.status).toBe(401)
  })

  it('A2: wrong X-API-Key → 401', async () => {
    const res = await getJson('/api/attachments/1/blob', 'wrong-key')
    expect(res.status).toBe(401)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
//  Bad input
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/attachments/:id/blob — bad input', () => {
  it('B1: non-numeric id → 400', async () => {
    const res = await getJson('/api/attachments/abc/blob', KEY)
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error: expect.stringContaining('invalid') })
  })

  it('B2: zero id → 400', async () => {
    const res = await getJson('/api/attachments/0/blob', KEY)
    expect(res.status).toBe(400)
  })

  it('B3: negative id → 400', async () => {
    const res = await getJson('/api/attachments/-5/blob', KEY)
    expect(res.status).toBe(400)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
//  404
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/attachments/:id/blob — 404', () => {
  it('C1: row not found → 404', async () => {
    q([]) // empty result
    const res = await getJson('/api/attachments/9999/blob', KEY)
    expect(res.status).toBe(404)
    expect(res.body).toMatchObject({ error: 'not found' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
//  Happy-path: JPEG image served inline
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/attachments/:id/blob — JPEG inline', () => {
  it('D1: returns 200 + correct Content-Type for image/jpeg', async () => {
    q([{ filename: 'photo.jpg', content_type: 'image/jpeg', size_bytes: TINY_JPEG.length, data: TINY_JPEG }])
    const res = await getBlob('/api/attachments/1/blob', KEY)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('image/jpeg')
  })

  it('D2: Content-Disposition is inline for image', async () => {
    q([{ filename: 'photo.jpg', content_type: 'image/jpeg', size_bytes: TINY_JPEG.length, data: TINY_JPEG }])
    const res = await getBlob('/api/attachments/1/blob', KEY)
    expect(res.headers.get('content-disposition')).toMatch(/^inline/)
  })

  it('D3: response body contains the raw bytes', async () => {
    q([{ filename: 'photo.jpg', content_type: 'image/jpeg', size_bytes: TINY_JPEG.length, data: TINY_JPEG }])
    const res = await getBlob('/api/attachments/1/blob', KEY)
    expect(Buffer.compare(res.body, TINY_JPEG)).toBe(0)
  })

  it('D4: Content-Length header matches size_bytes', async () => {
    q([{ filename: 'photo.jpg', content_type: 'image/jpeg', size_bytes: TINY_JPEG.length, data: TINY_JPEG }])
    const res = await getBlob('/api/attachments/1/blob', KEY)
    expect(Number(res.headers.get('content-length'))).toBe(TINY_JPEG.length)
  })

  it('D5: Cache-Control is private', async () => {
    q([{ filename: 'photo.jpg', content_type: 'image/jpeg', size_bytes: TINY_JPEG.length, data: TINY_JPEG }])
    const res = await getBlob('/api/attachments/1/blob', KEY)
    expect(res.headers.get('cache-control')).toContain('private')
  })

  it('D6: PNG image served inline', async () => {
    const pngData = Buffer.from([0x89, 0x50, 0x4E, 0x47])
    q([{ filename: 'image.png', content_type: 'image/png', size_bytes: pngData.length, data: pngData }])
    const res = await getBlob('/api/attachments/2/blob', KEY)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('image/png')
    expect(res.headers.get('content-disposition')).toMatch(/^inline/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
//  Safe MIME enforcement
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/attachments/:id/blob — safe MIME enforcement', () => {
  it('E1: SVG forced to application/octet-stream (XSS prevention)', async () => {
    const svgData = Buffer.from('<svg><script>alert(1)</script></svg>')
    q([{ filename: 'icon.svg', content_type: 'image/svg+xml', size_bytes: svgData.length, data: svgData }])
    const res = await getBlob('/api/attachments/3/blob', KEY)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/octet-stream')
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/)
  })

  it('E2: application/pdf forced to octet-stream', async () => {
    const pdfData = Buffer.from('%PDF-1.4 ...')
    q([{ filename: 'doc.pdf', content_type: 'application/pdf', size_bytes: pdfData.length, data: pdfData }])
    const res = await getBlob('/api/attachments/4/blob', KEY)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/octet-stream')
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/)
  })

  it('E3: text/html forced to octet-stream', async () => {
    const htmlData = Buffer.from('<html><script>alert(1)</script></html>')
    q([{ filename: 'page.html', content_type: 'text/html', size_bytes: htmlData.length, data: htmlData }])
    const res = await getBlob('/api/attachments/5/blob', KEY)
    expect(res.headers.get('content-type')).toContain('application/octet-stream')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
//  DB error
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/attachments/:id/blob — DB error', () => {
  it('F1: pg throw → 500', async () => {
    qErr('connection lost')
    const res = await getJson('/api/attachments/1/blob', KEY)
    expect(res.status).toBe(500)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
//  SQL wiring
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/attachments/:id/blob — SQL wiring', () => {
  it('G1: queries message_attachments table with correct id param', async () => {
    q([{ filename: 'f.jpg', content_type: 'image/jpeg', size_bytes: 4, data: Buffer.from([0,0,0,0]) }])
    await getBlob('/api/attachments/42/blob', KEY)
    const sql = calls.find(c => c.sql.includes('message_attachments'))
    expect(sql).toBeDefined()
    expect(sql!.params).toEqual([42])
  })
})
