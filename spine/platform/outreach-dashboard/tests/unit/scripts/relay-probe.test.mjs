// relay-probe.test.mjs
// Unit tests for scripts/lib/relay-probe.mjs — the helper extracted from
// verify-launch.mjs Gate 3 to fix the historical bug where the script
// POSTed `{ mailbox }` without an Authorization header (relay returned 401).
//
// These tests pin the calling convention so any future regression
// (drop the bearer token, change body shape) fails CI.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer } from 'node:http'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// here = features/platform/outreach-dashboard/tests/unit/scripts → 5 up = repo root
const REPO_ROOT = join(here, '..', '..', '..', '..', '..', '..')
const HELPER_PATH = join(REPO_ROOT, 'scripts', 'lib', 'relay-probe.mjs')

// Lightweight ephemeral HTTP server that captures the last incoming request
// and returns a configurable response.
function startCapturingServer({ statusCode = 200, responseBody = { checks: { smtp: { ok: true } } } } = {}) {
  const captured = { method: null, url: null, headers: null, body: null }
  const server = createServer((req, res) => {
    captured.method = req.method
    captured.url = req.url
    captured.headers = req.headers
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      try { captured.body = JSON.parse(raw) } catch { captured.body = raw }
      res.writeHead(statusCode, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(responseBody))
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, port, captured, base: `http://127.0.0.1:${port}` })
    })
  })
}

describe('probeMailboxViaRelay', () => {
  let probeMailboxViaRelay

  beforeAll(async () => {
    const mod = await import(HELPER_PATH)
    probeMailboxViaRelay = mod.probeMailboxViaRelay
  })

  // ── TC-01: Authorization: Bearer header is sent ─────────────────────────
  it('TC-01: sends Authorization: Bearer ${token} header when token provided', async () => {
    const { server, captured, base } = await startCapturingServer()
    try {
      await probeMailboxViaRelay({
        relayBase: base,
        token: 'test-token-abc-123',
        mailbox: { id: 1, from_address: 'a@b.cz', smtp_host: 'smtp.seznam.cz', smtp_port: 465, smtp_username: 'a@b.cz', password: 'pw' },
      })
      expect(captured.headers.authorization).toBe('Bearer test-token-abc-123')
    } finally {
      server.close()
    }
  })

  // ── TC-02: body shape matches relay probeRequest schema ─────────────────
  it('TC-02: POST body has {smtp_host, smtp_port, smtp_username, password} — NOT {mailbox}', async () => {
    const { server, captured, base } = await startCapturingServer()
    try {
      await probeMailboxViaRelay({
        relayBase: base,
        token: 'tok',
        mailbox: {
          id: 7,
          from_address: 'op@firma.cz',
          smtp_host: 'smtp.seznam.cz',
          smtp_port: 465,
          smtp_username: 'op@firma.cz',
          password: 'secretpw',
        },
      })
      expect(captured.body).toEqual({
        smtp_host: 'smtp.seznam.cz',
        smtp_port: 465,
        smtp_username: 'op@firma.cz',
        password: 'secretpw',
      })
      expect(captured.body).not.toHaveProperty('mailbox')
    } finally {
      server.close()
    }
  })

  // ── TC-03: smtp_port coerced to Number ──────────────────────────────────
  it('TC-03: smtp_port string from DB is coerced to integer', async () => {
    const { server, captured, base } = await startCapturingServer()
    try {
      await probeMailboxViaRelay({
        relayBase: base,
        token: 'tok',
        mailbox: { smtp_host: 'h', smtp_port: '465', smtp_username: 'u', password: 'p' },
      })
      expect(captured.body.smtp_port).toBe(465)
      expect(typeof captured.body.smtp_port).toBe('number')
    } finally {
      server.close()
    }
  })

  // ── TC-04: POST + /v1/probe path + Content-Type ─────────────────────────
  it('TC-04: hits POST /v1/probe with application/json content-type', async () => {
    const { server, captured, base } = await startCapturingServer()
    try {
      await probeMailboxViaRelay({
        relayBase: base, token: 'tok',
        mailbox: { smtp_host: 'h', smtp_port: 465, smtp_username: 'u', password: 'p' },
      })
      expect(captured.method).toBe('POST')
      expect(captured.url).toBe('/v1/probe')
      expect(captured.headers['content-type']).toMatch(/application\/json/)
    } finally {
      server.close()
    }
  })

  // ── TC-05: relayBase trailing slash normalized ──────────────────────────
  it('TC-05: trailing slash on relayBase is stripped', async () => {
    const { server, captured, base } = await startCapturingServer()
    try {
      await probeMailboxViaRelay({
        relayBase: base + '///',
        token: 'tok',
        mailbox: { smtp_host: 'h', smtp_port: 465, smtp_username: 'u', password: 'p' },
      })
      expect(captured.url).toBe('/v1/probe')
    } finally {
      server.close()
    }
  })

  // ── TC-06: 200 + checks.smtp.ok=true → ok:true ──────────────────────────
  it('TC-06: returns ok:true when relay reports checks.smtp.ok=true', async () => {
    const { server, base } = await startCapturingServer({
      statusCode: 200,
      responseBody: { checks: { smtp: { ok: true } } },
    })
    try {
      const r = await probeMailboxViaRelay({
        relayBase: base, token: 'tok',
        mailbox: { smtp_host: 'h', smtp_port: 465, smtp_username: 'u', password: 'p' },
      })
      expect(r.ok).toBe(true)
      expect(r.status).toBe(200)
      expect(r.error).toBeNull()
    } finally {
      server.close()
    }
  })

  // ── TC-07: 200 + checks.smtp.ok=false → ok:false with error ─────────────
  it('TC-07: returns ok:false when relay reports checks.smtp.ok=false', async () => {
    const { server, base } = await startCapturingServer({
      statusCode: 200,
      responseBody: { checks: { smtp: { ok: false, error: 'AUTH_FAILED' } } },
    })
    try {
      const r = await probeMailboxViaRelay({
        relayBase: base, token: 'tok',
        mailbox: { smtp_host: 'h', smtp_port: 465, smtp_username: 'u', password: 'p' },
      })
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/AUTH_FAILED/)
    } finally {
      server.close()
    }
  })

  // ── TC-08: 401 (the historical bug symptom) → ok:false ──────────────────
  it('TC-08: relay 401 (no/bad bearer) surfaces as ok:false with HTTP 401 in error', async () => {
    const { server, base } = await startCapturingServer({
      statusCode: 401,
      responseBody: { error: 'unauthorized' },
    })
    try {
      const r = await probeMailboxViaRelay({
        relayBase: base, token: '',
        mailbox: { smtp_host: 'h', smtp_port: 465, smtp_username: 'u', password: 'p' },
      })
      expect(r.ok).toBe(false)
      expect(r.status).toBe(401)
      expect(r.error).toMatch(/HTTP 401/)
    } finally {
      server.close()
    }
  })

  // ── TC-09: empty token → no Authorization header sent ───────────────────
  it('TC-09: omits Authorization header when token is empty (dev mode)', async () => {
    const { server, captured, base } = await startCapturingServer()
    try {
      await probeMailboxViaRelay({
        relayBase: base, token: '',
        mailbox: { smtp_host: 'h', smtp_port: 465, smtp_username: 'u', password: 'p' },
      })
      expect(captured.headers.authorization).toBeUndefined()
    } finally {
      server.close()
    }
  })

  // ── TC-10: connection refused → ok:false, status:0, fetch failed reason ─
  it('TC-10: connection failure returns ok:false status:0 with fetch-failed reason', async () => {
    // Port 1 is reserved/unbindable on most systems — guarantees ECONNREFUSED
    const r = await probeMailboxViaRelay({
      relayBase: 'http://127.0.0.1:1',
      token: 'tok',
      mailbox: { smtp_host: 'h', smtp_port: 465, smtp_username: 'u', password: 'p' },
      timeoutMs: 2_000,
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(0)
    expect(r.error).toMatch(/ECONNREFUSED|fetch failed|aborted|connect/i)
  })

  // ── TC-11: password is forwarded verbatim (not redacted in transport) ──
  it('TC-11: password field is sent verbatim in the body', async () => {
    const { server, captured, base } = await startCapturingServer()
    try {
      await probeMailboxViaRelay({
        relayBase: base, token: 'tok',
        mailbox: { smtp_host: 'h', smtp_port: 465, smtp_username: 'u', password: 'p@ss w0rd!' },
      })
      expect(captured.body.password).toBe('p@ss w0rd!')
    } finally {
      server.close()
    }
  })

  // ── TC-12: injectable fetchImpl for unit test isolation ─────────────────
  it('TC-12: fetchImpl can be injected (no real network required)', async () => {
    let captured = null
    const fakeFetch = async (url, init) => {
      captured = { url, init }
      return new Response(JSON.stringify({ checks: { smtp: { ok: true } } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    const r = await probeMailboxViaRelay({
      relayBase: 'http://relay.invalid',
      token: 'inject-tok',
      mailbox: { smtp_host: 'h', smtp_port: 465, smtp_username: 'u', password: 'p' },
      fetchImpl: fakeFetch,
    })
    expect(r.ok).toBe(true)
    expect(captured.url).toBe('http://relay.invalid/v1/probe')
    expect(captured.init.headers.Authorization).toBe('Bearer inject-tok')
    const body = JSON.parse(captured.init.body)
    expect(body).toEqual({ smtp_host: 'h', smtp_port: 465, smtp_username: 'u', password: 'p' })
  })
})
