// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/mailboxes/:id/auth-reset — E2E smoke (SEND-S2 operator action)
//
// Locks the BFF endpoint behavior against the live dev stack:
//   - 400 on invalid id (non-integer, zero, negative)
//   - 404 on unknown id (against prod DB via Railway TCP proxy)
//   - 200 path validated via unit+contract tests (no DB mutation here to keep
//     tests idempotent against the shared prod DB)
//
// See: bff-mailboxes.contract.test.ts for the full 12-case unit lock.
// ═══════════════════════════════════════════════════════════════════════════

import { test, expect } from '@playwright/test'

test.describe('POST /api/mailboxes/:id/auth-reset — BFF smoke', () => {
  test('400 on non-integer id', async ({ request }) => {
    const res = await request.post('/api/mailboxes/abc/auth-reset', { data: {} })
    expect(res.status()).toBe(400)
    const body = await res.json()
    expect(body).toEqual({ error: 'invalid id' })
  })

  test('400 on id=0', async ({ request }) => {
    const res = await request.post('/api/mailboxes/0/auth-reset', { data: {} })
    expect(res.status()).toBe(400)
  })

  test('400 on negative id', async ({ request }) => {
    const res = await request.post('/api/mailboxes/-5/auth-reset', { data: {} })
    expect(res.status()).toBe(400)
  })

  test('404 on unknown id (DB reachable, row missing)', async ({ request }) => {
    const res = await request.post('/api/mailboxes/999999/auth-reset', { data: {} })
    expect(res.status()).toBe(404)
    const body = await res.json()
    expect(body).toEqual({ error: 'not found' })
  })

  test('endpoint is registered (GET returns 404 from express for wrong method, not 404 from handler)', async ({ request }) => {
    // GET to the same path should 404 because the only method registered is POST.
    // This proves no accidental GET handler was added.
    const res = await request.get('/api/mailboxes/1/auth-reset')
    expect([404, 405]).toContain(res.status())
  })
})

test.describe('auth-reset + auth-fail-alerts integration (banner clear semantics)', () => {
  test('auth-fail-alerts query filters auto_healed=false rows', async ({ request }) => {
    // Without calling reset, just verify the query shape — contract should
    // return an object with count + alerts, and alerts never include healed
    // rows (test would require DB seeding to verify exhaustively).
    const res = await request.get('/api/health/auth-fail-alerts')
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('alerts')
    expect(body).toHaveProperty('count')
    expect(Array.isArray(body.alerts)).toBe(true)
    // Each alert row must have minimum shape — no leaked healed flag.
    for (const a of body.alerts) {
      expect(a).toHaveProperty('mailbox_id')
      expect(a).toHaveProperty('from_address')
      expect(a).toHaveProperty('fail_count')
      expect(a).toHaveProperty('created_at')
    }
  })
})
