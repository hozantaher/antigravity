/**
 * Contract tests for brand_label operator_settings integration (Sprint AL).
 *
 * Verifies:
 * - /privacy fetches controller_name from DB
 * - /unsubscribe fetches brand_label from DB
 * - /api/replies/:id/forward-to-crm and legacy /forward-to-garaaage both work
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Pool } from 'pg'
import request from 'supertest'
import express from 'express'
import { mountPrivacyRoutes } from '../../src/server-routes/privacy'
import { mountUnsubscribeRoutes } from '../../src/server-routes/unsubscribe'
import { mountRepliesRoutes } from '../../src/server-routes/replies'

describe('Sprint AL: Brand label operator_settings (contract)', () => {
  let app: express.Express
  let pool: Pool

  beforeEach(() => {
    app = express()
    app.use(express.json())

    // Mock pool
    pool = {
      query: vi.fn(),
      connect: vi.fn(),
    } as any
  })

  describe('GET /privacy', () => {
    it('fetches controller_name from operator_settings', async () => {
      ;(pool.query as any).mockResolvedValueOnce({
        rows: [{ value: 'Hozan s.r.o.' }],
      })

      mountPrivacyRoutes(app, { pool })

      const response = await request(app).get('/privacy')

      expect(response.status).toBe(200)
      expect(response.text).toContain('Zásady zpracování osobních údajů — Hozan s.r.o.')
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("SELECT value FROM operator_settings WHERE key='controller_name'"),
        undefined
      )
    })

    it('falls back to hardcoded "Garaaage s.r.o." when DB query fails', async () => {
      ;(pool.query as any).mockRejectedValueOnce(new Error('DB error'))

      mountPrivacyRoutes(app, { pool })

      const response = await request(app).get('/privacy')

      expect(response.status).toBe(200)
      expect(response.text).toContain('Garaaage s.r.o.')
    })

    it('falls back to hardcoded value when no pool provided', async () => {
      mountPrivacyRoutes(app)

      const response = await request(app).get('/privacy')

      expect(response.status).toBe(200)
      expect(response.text).toContain('Garaaage s.r.o.')
    })
  })

  describe('GET /unsubscribe', () => {
    it('fetches brand_label from operator_settings and uses it in title/h1', async () => {
      ;(pool.query as any)
        .mockResolvedValueOnce({
          rows: [{ value: 'Hozan' }],
        })
        .mockResolvedValueOnce({
          rows: [{ email: 'test@example.com' }],
        })

      const deps = {
        pool,
        capture500: vi.fn(),
        safeError: () => 'Error',
        Sentry: { captureException: vi.fn() },
      }

      mountUnsubscribeRoutes(app, deps as any)

      const response = await request(app)
        .get('/unsubscribe?c=123&id=456&t=abcdef0123456789')
        .set('X-Forwarded-For', '127.0.0.1')

      // First call fetches brand_label, second verifies token
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("SELECT value FROM operator_settings WHERE key='brand_label'"),
        undefined
      )
    })

    it('falls back to "Garaaage" when brand_label query fails', async () => {
      ;(pool.query as any)
        .mockRejectedValueOnce(new Error('DB error'))
        .mockResolvedValueOnce({
          rows: [{ email: 'test@example.com' }],
        })

      const deps = {
        pool,
        capture500: vi.fn(),
        safeError: () => 'Error',
        Sentry: { captureException: vi.fn() },
      }

      mountUnsubscribeRoutes(app, deps as any)

      const response = await request(app)
        .get('/unsubscribe?c=123&id=456&t=abcdef0123456789')
        .set('X-Forwarded-For', '127.0.0.1')

      expect(pool.query).toHaveBeenCalled()
    })
  })

  describe('POST /api/replies/:id/forward-to-crm (new endpoint)', () => {
    it('accepts crm_url field in request body', async () => {
      ;(pool.query as any)
        .mockResolvedValueOnce({ rows: [{ value: 'Hozan' }] }) // brand_label
        .mockResolvedValueOnce({
          rows: [{ id: 1, contact_id: 10, campaign_id: 5, from_email: 'test@example.com' }],
        }) // SELECT reply
        .mockResolvedValueOnce({ rows: [{ id: 1 }] }) // UPDATE reply handled
        .mockResolvedValueOnce({ rows: [] }) // INSERT healing_log

      mountRepliesRoutes(app, { pool: pool as any, setRouteTags: () => {}, capture500: (res: any, e: any, safeError: any) => { res.status(500).json({ error: safeError(e) }) }, safeError: (e: any) => e.message })

      const response = await request(app)
        .post('/api/replies/1/forward-to-crm')
        .send({ notes: 'Test handoff', crm_url: 'https://crm.example.com/listing/123' })

      expect(response.status).toBe(200)
      expect(response.body.ok).toBe(true)
      expect(response.body.crm_url).toBe('https://crm.example.com/listing/123')
    })

    it('includes brand_label in audit log', async () => {
      ;(pool.query as any)
        .mockResolvedValueOnce({ rows: [{ value: 'Hozan' }] })
        .mockResolvedValueOnce({
          rows: [{ id: 1, contact_id: 10, campaign_id: 5, from_email: 'test@example.com' }],
        })
        .mockResolvedValueOnce({ rows: [{ id: 1 }] })
        .mockResolvedValueOnce({ rows: [] })

      mountRepliesRoutes(app, { pool: pool as any, setRouteTags: () => {}, capture500: (res: any, e: any, safeError: any) => { res.status(500).json({ error: safeError(e) }) }, safeError: (e: any) => e.message })

      await request(app)
        .post('/api/replies/1/forward-to-crm')
        .send({ notes: 'Test', crm_url: 'https://example.com' })

      const healingLogCall = (pool.query as any).mock.calls.find((call: any) =>
        call[0].includes('INSERT INTO healing_log')
      )
      expect(healingLogCall).toBeDefined()
      expect(healingLogCall[0]).toContain('manual handoff to Hozan')
    })
  })

  describe('POST /api/replies/:id/forward-to-garaaage (legacy alias)', () => {
    it('still works for backward compatibility', async () => {
      ;(pool.query as any)
        .mockResolvedValueOnce({ rows: [{ value: 'Garaaage' }] })
        .mockResolvedValueOnce({
          rows: [{ id: 1, contact_id: 10, campaign_id: 5, from_email: 'test@example.com' }],
        })
        .mockResolvedValueOnce({ rows: [{ id: 1 }] })
        .mockResolvedValueOnce({ rows: [] })

      mountRepliesRoutes(app, { pool: pool as any, setRouteTags: () => {}, capture500: (res: any, e: any, safeError: any) => { res.status(500).json({ error: safeError(e) }) }, safeError: (e: any) => e.message })

      const response = await request(app)
        .post('/api/replies/1/forward-to-garaaage')
        .send({ notes: 'Legacy test', garaaage_url: 'https://example.com' })

      expect(response.status).toBe(200)
      expect(response.body.ok).toBe(true)
    })

    it('accepts garaaage_url field for backward compat', async () => {
      ;(pool.query as any)
        .mockResolvedValueOnce({ rows: [{ value: 'Garaaage' }] })
        .mockResolvedValueOnce({
          rows: [{ id: 1, contact_id: 10, campaign_id: 5, from_email: 'test@example.com' }],
        })
        .mockResolvedValueOnce({ rows: [{ id: 1 }] })
        .mockResolvedValueOnce({ rows: [] })

      mountRepliesRoutes(app, { pool: pool as any, setRouteTags: () => {}, capture500: (res: any, e: any, safeError: any) => { res.status(500).json({ error: safeError(e) }) }, safeError: (e: any) => e.message })

      const response = await request(app)
        .post('/api/replies/1/forward-to-garaaage')
        .send({ garaaage_url: 'https://example.com' })

      expect(response.status).toBe(200)
      expect(response.body.ok).toBe(true)
      expect(response.body.crm_url).toBe('https://example.com')
    })
  })
})
