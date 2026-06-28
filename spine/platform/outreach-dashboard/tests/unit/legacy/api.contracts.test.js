// Contract tests — Zod schemas pinned to API response shapes.
// A drift between server payload and dashboard expectations breaks here first.
// Run: pnpm vitest run src/api.contracts.test.js  (server must be on :3001)

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { z } from 'zod'
import { server as mswServer } from '../../../src/test/setup.js'

const BASE = 'http://localhost:3001'

beforeAll(() => mswServer.close())
afterAll(() => mswServer.listen({ onUnhandledRequest: 'warn' }))

async function get(path) {
  const r = await fetch(`${BASE}${path}`)
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`)
  return r.json()
}

// Pg numeric columns serialize as strings — tolerate both.
const numStr = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)])
const nullableStr = z.string().nullable()
const isoDate = z.string().datetime({ offset: true }).nullable()

// ── /api/mailboxes ────────────────────────────────────────────────────
const mailboxSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  display_name: nullableStr,
  host: nullableStr,
  port: z.number().int().nullable(),
  smtp_username: nullableStr,
  imap_host: nullableStr,
  imap_port: z.number().int().nullable(),
  daily_limit: z.number().int(),
  status: z.enum(['active', 'paused', 'failed', 'warmup', 'disabled']),
  status_reason: nullableStr,
  total_sent: numStr,
  total_bounced: numStr,
  consecutive_bounces: z.number().int(),
  last_send_at: isoDate,
  proxy_url: nullableStr,
  created_at: isoDate,
  updated_at: isoDate,
}).passthrough()

// ── /api/campaigns ────────────────────────────────────────────────────
const campaignSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: nullableStr,
  status: z.enum(['draft', 'active', 'paused', 'archived']),
  category_paths: z.array(z.string()),
  sequence_config: z.array(z.object({
    step: z.number().int(),
    template: z.string(),
    delay_days: z.number().int(),
  }).passthrough()),
  category_match: z.enum(['prefix', 'exact', 'any']).optional(),
  created_at: isoDate,
  stats: z.record(z.string(), z.unknown()).default({}),
}).passthrough()

// ── /api/templates ────────────────────────────────────────────────────
const templateSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  subject: z.string(),
  body: z.string(),
  created_at: isoDate,
}).passthrough()

// ── /api/segments ─────────────────────────────────────────────────────
const segmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: nullableStr,
  query: z.object({
    op: z.enum(['AND', 'OR']),
    conditions: z.array(z.unknown()),
  }).passthrough(),
  company_count: z.number().int(),
  created_at: isoDate,
}).passthrough()

// ── /api/contacts ─────────────────────────────────────────────────────
const contactSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  first_name: nullableStr,
  last_name: nullableStr,
  company_name: nullableStr,
  status: z.string(),
  last_contact_at: isoDate,
  total_sent: z.number().int(),
  suppressed: z.boolean(),
}).passthrough()

const pagedShape = (item) => z.object({ rows: z.array(item), total: z.number().int().nonnegative() })

// ── /api/companies ────────────────────────────────────────────────────
const companySchema = z.object({
  ico: z.string(),
  name: z.string(),
  category_path: nullableStr,
  email: z.string().nullable(),
  icp_tier: z.string().nullable(),
  email_status: z.string().nullable(),
}).passthrough()

// ── /api/replies ──────────────────────────────────────────────────────
const replySchema = z.object({
  id: z.union([z.string(), z.number()]),
  // Actual reply records validated when present; empty list is acceptable.
}).passthrough()

// ── tests ─────────────────────────────────────────────────────────────
describe('API contract: /api/mailboxes', () => {
  it('returns array conforming to mailbox schema', async () => {
    const data = await get('/api/mailboxes')
    expect(Array.isArray(data)).toBe(true)
    if (data.length > 0) {
      const result = mailboxSchema.array().safeParse(data)
      if (!result.success) console.error(result.error.issues.slice(0, 5))
      expect(result.success).toBe(true)
    }
  })
})

describe('API contract: /api/campaigns', () => {
  it('returns array conforming to campaign schema', async () => {
    const data = await get('/api/campaigns')
    expect(Array.isArray(data)).toBe(true)
    if (data.length > 0) {
      const result = campaignSchema.array().safeParse(data)
      if (!result.success) console.error(result.error.issues.slice(0, 5))
      expect(result.success).toBe(true)
    }
  })

  it('GET /api/campaigns/:id returns {campaign} envelope', async () => {
    const list = await get('/api/campaigns')
    if (list.length === 0) return
    const item = await get(`/api/campaigns/${list[0].id}`)
    const schema = z.object({ campaign: campaignSchema }).passthrough()
    const result = schema.safeParse(item)
    if (!result.success) console.error(result.error.issues.slice(0, 5))
    expect(result.success).toBe(true)
  })
})

describe('API contract: /api/templates', () => {
  it('returns array conforming to template schema', async () => {
    const data = await get('/api/templates')
    expect(Array.isArray(data)).toBe(true)
    if (data.length > 0) {
      const result = templateSchema.array().safeParse(data)
      if (!result.success) console.error(result.error.issues.slice(0, 5))
      expect(result.success).toBe(true)
    }
  })
})

describe('API contract: /api/segments', () => {
  it('returns array conforming to segment schema', async () => {
    const data = await get('/api/segments')
    expect(Array.isArray(data)).toBe(true)
    if (data.length > 0) {
      const result = segmentSchema.array().safeParse(data)
      if (!result.success) console.error(result.error.issues.slice(0, 5))
      expect(result.success).toBe(true)
    }
  })
})

describe('API contract: /api/contacts', () => {
  it('returns paged shape with contact rows', async () => {
    const data = await get('/api/contacts?limit=5')
    const schema = pagedShape(contactSchema)
    const result = schema.safeParse(data)
    if (!result.success) console.error(result.error.issues.slice(0, 5))
    expect(result.success).toBe(true)
  })
})

describe('API contract: /api/companies', () => {
  it('returns paged shape with company rows', async () => {
    const data = await get('/api/companies?limit=3')
    expect(data).toHaveProperty('rows')
    expect(Array.isArray(data.rows)).toBe(true)
    if (data.rows.length > 0) {
      const result = companySchema.array().safeParse(data.rows)
      if (!result.success) console.error(result.error.issues.slice(0, 5))
      expect(result.success).toBe(true)
    }
  })

  it('GET /api/companies/stats returns {total: number}', async () => {
    const data = await get('/api/companies/stats')
    const schema = z.object({ total: z.number().int().nonnegative() }).passthrough()
    expect(schema.safeParse(data).success).toBe(true)
  })
})

describe('API contract: /api/replies', () => {
  it('returns paged shape (rows may be empty)', async () => {
    const data = await get('/api/replies?limit=5')
    const schema = z.object({ rows: z.array(replySchema), total: z.number().int().nonnegative() })
    const result = schema.safeParse(data)
    if (!result.success) console.error(result.error.issues.slice(0, 5))
    expect(result.success).toBe(true)
  })
})

// ── header sanity ────────────────────────────────────────────────────
describe('API contract: response headers', () => {
  it('JSON endpoints return application/json', async () => {
    const r = await fetch(`${BASE}/api/mailboxes`)
    expect(r.headers.get('content-type')).toMatch(/application\/json/)
  })

  it('rejects unknown endpoint with 404', async () => {
    const r = await fetch(`${BASE}/api/__not_a_real_endpoint__`)
    expect(r.status).toBe(404)
  })
})
