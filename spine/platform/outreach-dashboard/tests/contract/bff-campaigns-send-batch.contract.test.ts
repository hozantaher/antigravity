// K1 / H2.4 — BFF contract: POST /api/campaigns/:id/send-batch
//
// Verifies:
//   1. Missing X-Confirm-Send → 412
//   2. Invalid campaign_id (non-numeric) → 400
//   3. count=0 → 400
//   4. count=101 → 400 (max 100)
//   5. Campaign not found → 404
//   6. Happy path → 200 with envelope_ids array
//   7. No pending contacts → 200 ok with sent=0
//   8. Relay submit failure → contact reverted, failed++ in summary
//   9. Idempotency: prior audit log entry → skipped_idempotent count
//  10. Audit log INSERT is called per envelope (actor = 'bff-send-batch')
//  11. PII guard: raw email addresses NOT in 200 response body
//  12. count=1 is minimum valid value

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

// ── Mock pg ──────────────────────────────────────────────────────────────────
type QueryOutcome = { rows: unknown[]; rowCount?: number } | Error

const queryQueue: QueryOutcome[] = []
const calls: Array<{ sql: string; params?: unknown[] }> = []

class FakeClient {
  async query(sql: string, params?: unknown[]) {
    // BEGIN / COMMIT / ROLLBACK are control statements; log them but don't
    // consume from the data queue so test fixtures stay aligned.
    const trimmed = typeof sql === 'string' ? sql.trim().toUpperCase() : ''
    if (trimmed === 'BEGIN' || trimmed === 'COMMIT' || trimmed === 'ROLLBACK') {
      calls.push({ sql, params })
      return { rows: [], rowCount: 0 }
    }
    calls.push({ sql, params })
    if (!queryQueue.length) return { rows: [], rowCount: 0 }
    const next = queryQueue.shift()!
    if (next instanceof Error) throw next
    return next
  }
  release() {}
}

vi.mock('pg', () => {
  class Pool {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params })
      if (!queryQueue.length) return { rows: [], rowCount: 0 }
      const next = queryQueue.shift()!
      if (next instanceof Error) throw next
      return next
    }
    async connect() { return new FakeClient() }
    on() {}
    end() {}
  }
  return { default: { Pool }, Pool }
})

vi.mock('../../staleGuard.js', () => ({ runGuards: vi.fn(), logBootRecovery: vi.fn() }))
vi.mock('../../configDrift.js', () => ({ runConfigDrift: vi.fn() }))
// AR7 send window gate fires BEFORE the X-Confirm-Send consent check.
// Mock it open so send-batch contract tests exercise the full path.
vi.mock('../../src/lib/automation.js', () => ({
  isWithinSendWindow: vi.fn(() => true),
}))

// ── Server + fetch setup ──────────────────────────────────────────────────────
type RelayCall = { url: string; body: unknown }
const relayCalls: RelayCall[] = []
// Default relay response — can be overridden per test
let relayResponse: { status: number; body: string } | Error = {
  status: 200,
  body: '{"envelope_id":"env-default-123"}',
}

const API_KEY = 'test-key-send-batch'
let baseUrl = ''
let server: import('http').Server
const savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  for (const k of [
    'BFF_IMPORT_ONLY', 'BFF_AUTH_DISABLED', 'DATABASE_URL', 'OUTREACH_API_KEY',
    'ANTI_TRACE_URL', 'ANTI_TRACE_TOKEN', 'ANTI_TRACE_RELAY_URL', 'ANTI_TRACE_RELAY_TOKEN',
  ]) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.BFF_AUTH_DISABLED = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  // Set relay env so the endpoint doesn't 503
  process.env.ANTI_TRACE_URL = 'https://relay.test'
  process.env.ANTI_TRACE_TOKEN = 'test-relay-token'

  // Intercept fetch: relay.test → mock; everything else → real fetch
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url.toString()
    if (urlStr.includes('relay.test')) {
      relayCalls.push({ url: urlStr, body: init?.body ? JSON.parse(init.body as string) : null })
      if (relayResponse instanceof Error) throw relayResponse
      return new Response(relayResponse.body, { status: relayResponse.status })
    }
    return originalFetch(url as string, init)
  }) as typeof fetch

  const mod = await import('../../server.js')
  // Re-set after import (loadEnv may clobber — feedback_vite_loadenv_gotcha)
  process.env.ANTI_TRACE_URL = 'https://relay.test'
  process.env.ANTI_TRACE_TOKEN = 'test-relay-token'
  delete process.env.ANTI_TRACE_RELAY_URL
  delete process.env.ANTI_TRACE_RELAY_TOKEN
  process.env.OUTREACH_API_KEY = API_KEY

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

beforeEach(async () => {
  queryQueue.length = 0
  calls.length = 0
  relayCalls.length = 0
  relayResponse = { status: 200, body: '{"envelope_id":"env-default-123"}' }
  // Reset per-campaign rate-limit state so tests using the same campaign_id
  // don't bleed 429 into each other (Sprint T4).
  await clearRateLimitState()
})

// ── Helpers ───────────────────────────────────────────────────────────────────

// Sprint T4: clear per-campaign rate-limit state so tests don't bleed into
// each other. All tests in this file use campaign 455 — without this reset,
// every test after the first would hit 429 instead of exercising its own path.
async function clearRateLimitState() {
  const mod = await import('../../src/server-routes/campaigns.js')
  const m = (mod as Record<string, unknown>)['_sendBatchLastCall']
  if (m instanceof Map) m.clear()
}

function queueRows(rows: unknown[], rowCount?: number) {
  queryQueue.push({ rows, rowCount: rowCount ?? rows.length })
}

const CAMPAIGN_ROW = {
  id: 455,
  name: 'Test kampaň',
  sequence_config: [{ template: 'initial' }],
  sending_config: { mailbox_pool: [1] },
}
const TEMPLATE_ROW = {
  id: 10,
  name: 'initial',
  subject: 'Dobrý den {{firma}}',
  body: 'Vážení {{firma}},\n{{podpis}}\n{{unsuburl}}',
}
const MAILBOX_ROW = {
  id: 1,
  from_address: 'mb1@seznam.cz',
  smtp_host: 'smtp.seznam.cz',
  smtp_port: 465,
  smtp_username: 'mb1@seznam.cz',
  password: 'S3cureP@ss2026!',
}
const CONTACT_ROW = {
  cc_id: 9001,
  contact_id: 42,
  status: 'pending',
  email: 'firma@example.com',
  first_name: 'Jan',
  last_name: 'Novak',
  company_name: 'ACME s.r.o.',
  region: 'Praha',
  ico: '12345678',
  // H5.3 LIA scope: NACE 41 (výstavba budov) — in scope per LIA v1.2
  nace_codes: ['41200'],
}

async function postSendBatch(
  campaignId: string | number,
  count: number,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const url = `${baseUrl}/api/campaigns/${campaignId}/send-batch?count=${count}`
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  })
  const text = await r.text()
  let body: unknown
  try { body = JSON.parse(text) } catch { body = text }
  return { status: r.status, body }
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('POST /api/campaigns/:id/send-batch', () => {

  // Test 1: Missing X-Confirm-Send header → 412
  it('1. returns 412 when X-Confirm-Send header is missing', async () => {
    const { status, body } = await postSendBatch(455, 1)
    expect(status).toBe(412)
    expect((body as Record<string,unknown>).error).toContain('X-Confirm-Send')
  })

  // Test 2: Non-numeric campaign_id → 400
  it('2. returns 400 for non-numeric campaign_id', async () => {
    const { status, body } = await postSendBatch('abc', 1, { 'x-confirm-send': '1' })
    expect(status).toBe(400)
    expect((body as Record<string,unknown>).error).toContain('invalid campaign_id')
  })

  // Test 3: count=0 → 400
  it('3. returns 400 when count=0', async () => {
    const { status, body } = await postSendBatch(455, 0, { 'x-confirm-send': '1' })
    expect(status).toBe(400)
    expect((body as Record<string,unknown>).error).toContain('count must be between 1 and 100')
  })

  // Test 4: count=101 → 400 (max 100)
  it('4. returns 400 when count=101 exceeds max', async () => {
    const { status, body } = await postSendBatch(455, 101, { 'x-confirm-send': '1' })
    expect(status).toBe(400)
    expect((body as Record<string,unknown>).error).toContain('count must be between 1 and 100')
  })

  // Test 5: Campaign not found → 404
  it('5. returns 404 when campaign does not exist', async () => {
    queueRows([]) // campaigns query → empty
    const { status, body } = await postSendBatch(9999, 1, { 'x-confirm-send': '1' })
    expect(status).toBe(404)
    expect((body as Record<string,unknown>).error).toMatch(/not found/i)
  })

  // Test 6: Happy path → 200 with envelope array
  it('6. happy path returns 200 with envelope_ids', async () => {
    relayResponse = { status: 200, body: '{"envelope_id":"env-abc"}' }

    // Query sequence for sendCampaignBatch (Sprint AI added 2 pre-campaign queries):
    // checkAggregateCap → getLIAScopeNACE → campaigns → templates → mailboxes →
    // [FakeClient: SELECT FOR UPDATE → UPDATE queued] →
    // acquireClaim → confirmClaim → send_events → audit INSERT → UPDATE in_sequence → batch audit INSERT
    queueRows([])                    // checkAggregateCap (empty → no cap block)
    queueRows([])                    // getLIAScopeNACE (empty → legacy fallback)
    queueRows([CAMPAIGN_ROW])        // campaigns
    queueRows([TEMPLATE_ROW])        // email_templates
    queueRows([MAILBOX_ROW])         // outreach_mailboxes

    // FakeClient transaction:
    queueRows([CONTACT_ROW])         // SELECT FOR UPDATE
    queueRows([], 1)                 // UPDATE queued

    queueRows([{ outcome: 'acquired' }]) // acquireClaim → proceed (send_claims mutex)
    queueRows([], 1)                 // confirmClaim (claiming→sent)
    queueRows([], 1)                 // send_events INSERT (fires warmup-cap trigger)
    queueRows([], 1)                 // audit log INSERT
    queueRows([], 1)                 // UPDATE in_sequence
    queueRows([], 1)                 // batch-level audit INSERT

    const { status, body } = await postSendBatch(455, 1, { 'x-confirm-send': '1' })
    expect(status).toBe(200)
    const b = body as Record<string, unknown>
    expect(b.ok).toBe(true)
    expect(b.campaign_id).toBe(455)
    expect(b.sent).toBe(1)
    expect(b.failed).toBe(0)
    const envelopes = b.envelopes as Array<Record<string, unknown>>
    expect(envelopes).toHaveLength(1)
    expect(envelopes[0].envelope_id).toBe('env-abc')
    expect(envelopes[0].contact_id).toBe(42)
  })

  // Test 7: No pending contacts → 200 ok with sent=0
  it('7. returns 200 with sent=0 when no pending contacts', async () => {
    queueRows([])              // checkAggregateCap (empty → no cap block)
    queueRows([])              // getLIAScopeNACE (empty → legacy fallback)
    queueRows([CAMPAIGN_ROW])
    queueRows([TEMPLATE_ROW])
    queueRows([MAILBOX_ROW])
    // FakeClient: SELECT FOR UPDATE → empty → no UPDATE queued
    queueRows([])    // SELECT FOR UPDATE → empty (early return, no batch audit INSERT)

    const { status, body } = await postSendBatch(455, 5, { 'x-confirm-send': '1' })
    expect(status).toBe(200)
    const b = body as Record<string, unknown>
    expect(b.ok).toBe(true)
    expect(b.picked).toBe(0)
    expect(b.sent).toBe(0)
    expect(b.envelopes).toEqual([])
  })

  // Test 8: Relay submit failure → contact reverted, failed++ in summary
  it('8. relay submit failure → failed++ and contact reverted to pending', async () => {
    relayResponse = { status: 500, body: '{"error":"relay_internal_error"}' }

    queueRows([])              // checkAggregateCap
    queueRows([])              // getLIAScopeNACE
    queueRows([CAMPAIGN_ROW])
    queueRows([TEMPLATE_ROW])
    queueRows([MAILBOX_ROW])
    queueRows([CONTACT_ROW])   // SELECT FOR UPDATE
    queueRows([], 1)           // UPDATE queued
    queueRows([{ outcome: 'acquired' }]) // acquireClaim → proceed
    // relay returns non-envelope_id → release claim + revert
    queueRows([], 1)           // releaseClaim (claiming→failed)
    queueRows([], 1)           // UPDATE pending (revert, best-effort)
    queueRows([], 1)           // batch audit INSERT

    const { status, body } = await postSendBatch(455, 1, { 'x-confirm-send': '1' })
    expect(status).toBe(200)
    const b = body as Record<string, unknown>
    expect(b.sent).toBe(0)
    expect(b.failed).toBe(1)
    const envelopes = b.envelopes as Array<Record<string, unknown>>
    expect(envelopes[0].envelope_id).toBeNull()
    expect(typeof envelopes[0].error).toBe('string')
  })

  // Test 9: Idempotency — existing audit log entry → skipped_idempotent++
  it('9. idempotency: prior audit log entry → skipped_idempotent count increases', async () => {
    queueRows([])              // checkAggregateCap
    queueRows([])              // getLIAScopeNACE
    queueRows([CAMPAIGN_ROW])
    queueRows([TEMPLATE_ROW])
    queueRows([MAILBOX_ROW])
    queueRows([CONTACT_ROW])   // SELECT FOR UPDATE
    queueRows([], 1)           // UPDATE queued
    // acquireClaim finds a prior 'sent' claim → ALREADY_SENT (idempotent skip)
    queueRows([{ outcome: 'sent' }])
    queueRows([], 1)           // UPDATE in_sequence catch-up (best-effort)
    queueRows([], 1)           // batch audit INSERT

    const { status, body } = await postSendBatch(455, 1, { 'x-confirm-send': '1' })
    expect(status).toBe(200)
    const b = body as Record<string, unknown>
    expect(b.skipped_idempotent).toBe(1)
    expect(b.sent).toBe(1) // idempotent still counts as handled
    const envelopes = b.envelopes as Array<Record<string, unknown>>
    expect(envelopes[0].skipped).toBe(true)
    expect(envelopes[0].envelope_id).toBeNull() // already_sent path pushes a null envelope_id
    // Relay should NOT have been called
    expect(relayCalls).toHaveLength(0)
  })

  // Test 10: Audit log INSERT is called per envelope with actor=bff-send-batch
  it('10. audit log INSERT uses actor=bff-send-batch per envelope', async () => {
    relayResponse = { status: 200, body: '{"envelope_id":"env-audit-check"}' }

    queueRows([])              // checkAggregateCap
    queueRows([])              // getLIAScopeNACE
    queueRows([CAMPAIGN_ROW])
    queueRows([TEMPLATE_ROW])
    queueRows([MAILBOX_ROW])
    queueRows([CONTACT_ROW])
    queueRows([], 1)          // UPDATE queued
    queueRows([{ outcome: 'acquired' }]) // acquireClaim → proceed
    queueRows([], 1)          // confirmClaim
    queueRows([], 1)          // send_events INSERT
    queueRows([], 1)          // audit INSERT
    queueRows([], 1)          // UPDATE in_sequence
    queueRows([], 1)          // batch audit INSERT

    await postSendBatch(455, 1, { 'x-confirm-send': '1' })

    // Find per-envelope audit INSERT
    const auditCall = calls.find(c =>
      typeof c.sql === 'string' &&
      c.sql.includes('campaign_contact_send') &&
      c.sql.includes('bff-send-batch'),
    )
    expect(auditCall).toBeDefined()
    // params should contain 'env-audit-check'
    expect(auditCall?.params?.some(p => p === 'env-audit-check')).toBe(true)
  })

  // Test 11: PII guard — raw email addresses NOT in response body
  it('11. PII guard: raw email addresses are not present in the 200 response body', async () => {
    relayResponse = { status: 200, body: '{"envelope_id":"env-pii-test"}' }

    queueRows([])              // checkAggregateCap
    queueRows([])              // getLIAScopeNACE
    queueRows([CAMPAIGN_ROW])
    queueRows([TEMPLATE_ROW])
    queueRows([MAILBOX_ROW])
    queueRows([CONTACT_ROW])
    queueRows([], 1)                     // UPDATE queued
    queueRows([{ outcome: 'acquired' }]) // acquireClaim → proceed
    queueRows([], 1)                     // confirmClaim
    queueRows([], 1)                     // send_events INSERT
    queueRows([], 1)                     // audit INSERT
    queueRows([], 1)                     // UPDATE in_sequence
    queueRows([], 1)                     // batch audit INSERT

    const r = await fetch(`${baseUrl}/api/campaigns/455/send-batch?count=1`, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'x-confirm-send': '1' },
    })
    const text = await r.text()
    expect(r.status).toBe(200)
    // Recipient + mailbox emails must not appear raw in the response
    expect(text).not.toContain('firma@example.com')
    expect(text).not.toContain('mb1@seznam.cz')
  })

  // Test 12: count=100 is maximum valid value
  it('12. count=100 is the maximum valid value (not rejected)', async () => {
    // Only testing validation — no need to set up full DB state
    // count=100 should pass validation and attempt campaign lookup
    queueRows([]) // campaigns → empty (404)
    const { status } = await postSendBatch(455, 100, { 'x-confirm-send': '1' })
    // Should NOT be 400 (validation passed), but 404 since campaign empty
    expect(status).not.toBe(400)
    expect(status).toBe(404)
  })
})
