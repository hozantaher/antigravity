// bff-segment-preview.contract.test.js — Sprint K1 (#1289)
//
// Contract tests for GET /api/segments/preview
//
// Verifies:
//   - Response shape (total_matching, skipped_dedup, domain_coverage, breakdown_by_email_status)
//   - Filter params are forwarded to the query (email_status, sectors, regions)
//   - dedup=on triggers the sample estimation path
//   - dedup=off (default) skips the sample query
//   - PII guard: response never contains email addresses
//   - 500 on pool error
//   - Edge cases: empty set, zero domains, null email statuses

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

import { mountSegmentPreviewRoutes } from '../../src/server-routes/segmentPreview.js'

function makeApp(poolMock) {
  const app = express()
  app.use(express.json())
  const capture500 = (res, err) => res.status(500).json({ error: err?.message ?? String(err) })
  const safeError = (e) => e?.message ?? String(e)
  mountSegmentPreviewRoutes(app, { pool: poolMock, capture500, safeError })
  return app
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePool(...results) {
  const queue = [...results]
  return {
    query: vi.fn(async () => {
      if (!queue.length) return { rows: [], rowCount: 0 }
      return queue.shift()
    }),
  }
}

const TOTAL_ROW    = { rows: [{ count: '150' }] }
const BREAKDOWN    = { rows: [{ valid: '100', invalid: '20', risky: '15', null: '15' }] }
const DOMAIN_ROWS  = { rows: [{ unique_domains: '40', max_per_domain: '8', top_domains: [{ domain: 'firma.cz', count: 8 }, { domain: 'acme.cz', count: 5 }] }] }
const DEDUP_SAMPLE = { rows: [{ skipped: '30' }] }

// ── Shape tests ───────────────────────────────────────────────────────────────

describe('GET /api/segments/preview — response shape', () => {
  it('returns all required top-level fields', async () => {
    const pool = makePool(TOTAL_ROW, BREAKDOWN, DOMAIN_ROWS)
    const res = await request(makeApp(pool)).get('/api/segments/preview')
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('total_matching')
    expect(res.body).toHaveProperty('skipped_dedup')
    expect(res.body).toHaveProperty('domain_coverage')
    expect(res.body).toHaveProperty('breakdown_by_email_status')
  })

  it('total_matching is a number', async () => {
    const pool = makePool(TOTAL_ROW, BREAKDOWN, DOMAIN_ROWS)
    const res = await request(makeApp(pool)).get('/api/segments/preview')
    expect(typeof res.body.total_matching).toBe('number')
    expect(res.body.total_matching).toBe(150)
  })

  it('breakdown_by_email_status has valid/invalid/risky/null keys', async () => {
    const pool = makePool(TOTAL_ROW, BREAKDOWN, DOMAIN_ROWS)
    const res = await request(makeApp(pool)).get('/api/segments/preview')
    const b = res.body.breakdown_by_email_status
    expect(b).toHaveProperty('valid', 100)
    expect(b).toHaveProperty('invalid', 20)
    expect(b).toHaveProperty('risky', 15)
    expect(b).toHaveProperty('null', 15)
  })

  it('domain_coverage has unique_domains, max_per_domain, top_domains', async () => {
    const pool = makePool(TOTAL_ROW, BREAKDOWN, DOMAIN_ROWS)
    const res = await request(makeApp(pool)).get('/api/segments/preview')
    const d = res.body.domain_coverage
    expect(d).toHaveProperty('unique_domains', 40)
    expect(d).toHaveProperty('max_per_domain', 8)
    expect(Array.isArray(d.top_domains)).toBe(true)
    expect(d.top_domains[0]).toHaveProperty('domain')
    expect(d.top_domains[0]).toHaveProperty('count')
  })

  it('skipped_dedup is null when dedup not requested', async () => {
    const pool = makePool(TOTAL_ROW, BREAKDOWN, DOMAIN_ROWS)
    const res = await request(makeApp(pool)).get('/api/segments/preview')
    expect(res.body.skipped_dedup).toBeNull()
  })
})

// ── Dedup estimation ──────────────────────────────────────────────────────────

describe('GET /api/segments/preview?dedup=on', () => {
  it('returns estimated skipped_dedup when dedup=on', async () => {
    const pool = makePool(TOTAL_ROW, BREAKDOWN, DOMAIN_ROWS, DEDUP_SAMPLE)
    const res = await request(makeApp(pool)).get('/api/segments/preview?dedup=on')
    expect(res.status).toBe(200)
    // 30 skipped out of min(200, 150)=150 sampled → scaled to 150 total
    // = round(30/150 * 150) = 30
    expect(typeof res.body.skipped_dedup).toBe('number')
    expect(res.body.skipped_dedup).toBe(30)
  })

  it('dedup on an empty matching set yields skipped_dedup=0 (no total_matching gate)', async () => {
    // New contract: the dedup estimate no longer short-circuits on the company
    // COUNT (total_matching). dedup=on always issues the contact-level dedup
    // query (breakdown + domain + dedup = 3 queries). The dedup query returns
    // population/sampled/skipped; an empty eligible CONTACT sample (sampled=0)
    // yields skipped_dedup=0 — not null.
    const pool = makePool(
      { rows: [{ total: '0', valid: '0', invalid: '0', risky: '0', null: '0' }] }, // breakdown (total folded in)
      { rows: [{ unique_domains: '0', max_per_domain: '0', top_domains: null }] },  // domain coverage
      { rows: [{ population: '0', sampled: '0', skipped: '0' }] },                  // dedup sample → empty set
    )
    const res = await request(makeApp(pool)).get('/api/segments/preview?dedup=on')
    expect(res.status).toBe(200)
    // Empty contact sample → 0 estimated skips (sampleSize===0 guard returns 0).
    expect(res.body.skipped_dedup).toBe(0)
    // breakdown + domain + dedup = 3 queries.
    expect(pool.query).toHaveBeenCalledTimes(3)
  })
})

// ── Filter params forwarding ──────────────────────────────────────────────────

describe('GET /api/segments/preview — filter params', () => {
  it('includes email_status filter in SQL when provided', async () => {
    const pool = makePool(TOTAL_ROW, BREAKDOWN, DOMAIN_ROWS)
    await request(makeApp(pool)).get('/api/segments/preview?email_status=valid,risky')
    const calls = pool.query.mock.calls
    // At least one SQL call must reference email_status
    const anyEmailFilter = calls.some(([sql, params]) =>
      String(sql).includes('email_status') || String(params).includes('valid'),
    )
    expect(anyEmailFilter).toBe(true)
  })

  it('includes region filter in SQL when provided', async () => {
    const pool = makePool(TOTAL_ROW, BREAKDOWN, DOMAIN_ROWS)
    await request(makeApp(pool)).get('/api/segments/preview?regions=Praha,Brno')
    const calls = pool.query.mock.calls
    const anyRegionFilter = calls.some(([sql, params]) =>
      String(sql).includes('region_normalized') ||
      (Array.isArray(params) && params.some(p => String(p).includes('Praha'))),
    )
    expect(anyRegionFilter).toBe(true)
  })

  it('includes sector filter in SQL when provided', async () => {
    const pool = makePool(TOTAL_ROW, BREAKDOWN, DOMAIN_ROWS)
    await request(makeApp(pool)).get('/api/segments/preview?sectors=41,42')
    const calls = pool.query.mock.calls
    const anySectorFilter = calls.some(([sql, params]) =>
      String(sql).includes('nace_codes') ||
      (Array.isArray(params) && params.some(p => String(p).startsWith('41'))),
    )
    expect(anySectorFilter).toBe(true)
  })
})

// ── PII guard ─────────────────────────────────────────────────────────────────

describe('GET /api/segments/preview — PII guard', () => {
  it('response body never contains an @-sign (no email leaked)', async () => {
    const pool = makePool(TOTAL_ROW, BREAKDOWN, DOMAIN_ROWS)
    const res = await request(makeApp(pool)).get('/api/segments/preview')
    const body = JSON.stringify(res.body)
    expect(body).not.toMatch(/@\w/)
  })

  it('top_domains only contains domain strings (no full email addresses)', async () => {
    const domainWithAt = {
      rows: [{
        unique_domains: '1',
        max_per_domain: '1',
        top_domains: [{ domain: 'firma.cz', count: 1 }],
      }],
    }
    const pool = makePool(TOTAL_ROW, BREAKDOWN, domainWithAt)
    const res = await request(makeApp(pool)).get('/api/segments/preview')
    const domains = res.body.domain_coverage.top_domains ?? []
    for (const d of domains) {
      // domain field must not contain a local-part (no @)
      expect(d.domain).not.toContain('@')
    }
  })
})

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('GET /api/segments/preview — edge cases', () => {
  it('handles null top_domains gracefully', async () => {
    const pool = makePool(
      TOTAL_ROW,
      BREAKDOWN,
      { rows: [{ unique_domains: '5', max_per_domain: '2', top_domains: null }] },
    )
    const res = await request(makeApp(pool)).get('/api/segments/preview')
    expect(res.status).toBe(200)
    expect(res.body.domain_coverage.top_domains).toEqual([])
  })

  it('handles null email status values in ?email_status=null', async () => {
    const pool = makePool(TOTAL_ROW, BREAKDOWN, DOMAIN_ROWS)
    const res = await request(makeApp(pool)).get('/api/segments/preview?email_status=null')
    expect(res.status).toBe(200)
    // SQL must check for IS NULL
    const calls = pool.query.mock.calls
    const anyNullCheck = calls.some(([sql]) =>
      String(sql).includes('IS NULL'),
    )
    expect(anyNullCheck).toBe(true)
  })

  it('handles multiple email statuses including null', async () => {
    const pool = makePool(TOTAL_ROW, BREAKDOWN, DOMAIN_ROWS)
    const res = await request(makeApp(pool)).get('/api/segments/preview?email_status=valid,null')
    expect(res.status).toBe(200)
  })
})

// ── Error handling ────────────────────────────────────────────────────────────

describe('GET /api/segments/preview — error handling', () => {
  it('returns 500 when pool throws on first query', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('db down')) }
    const res = await request(makeApp(pool)).get('/api/segments/preview')
    expect(res.status).toBe(500)
    expect(res.body).toHaveProperty('error')
  })

  it('returns 500 when pool throws on breakdown query', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce(TOTAL_ROW)
        .mockRejectedValue(new Error('breakdown fail')),
    }
    const res = await request(makeApp(pool)).get('/api/segments/preview')
    expect(res.status).toBe(500)
  })
})
