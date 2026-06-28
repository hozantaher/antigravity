// bff-reply-inbox-attachments.contract.test.js
// Matched-reply attachments now come from reply_inbox_attachments (migration
// 144 — byte-backed, so hot-lead seller photos are servable). The manifest
// prefers it and falls back to reply_inbox.attachments_meta for pre-144 rows.

import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

async function makeApp(pool) {
  const app = express()
  const { mountMessageAttachmentsRoutes } = await import('../../src/server-routes/messageAttachments.js')
  mountMessageAttachmentsRoutes(app, { pool, capture500: (res, e) => res.status(500).json({ error: e.message }), safeError: (e) => e })
  return app
}

describe('GET /api/replies/:id/attachments (matched, positive id)', () => {
  it('prefers reply_inbox_attachments when present', async () => {
    const pool = { query: vi.fn().mockResolvedValueOnce({ rows: [{ idx: 0, filename: 'foto.jpg', content_type: 'image/jpeg', size_bytes: 100, sha256: 'x', is_inline: true }] }) }
    const res = await request(await makeApp(pool)).get('/api/replies/97/attachments')
    expect(res.status).toBe(200)
    expect(res.body.source).toBe('reply_inbox_attachments')
    expect(res.body.attachments).toHaveLength(1)
    // first query hits reply_inbox_attachments
    expect(pool.query.mock.calls[0][0]).toMatch(/reply_inbox_attachments/)
  })

  it('falls back to attachments_meta when no byte-backed rows (pre-144)', async () => {
    const pool = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [] }) // reply_inbox_attachments empty
      .mockResolvedValueOnce({ rows: [{ attachments_meta: [{ filename: 'old.pdf', content_type: 'application/pdf' }], source_unmatched_id: null }] }) }
    const res = await request(await makeApp(pool)).get('/api/replies/97/attachments')
    expect(res.status).toBe(200)
    expect(res.body.source).toBe('reply_inbox')
    expect(res.body.attachments[0].filename).toBe('old.pdf')
  })

  it('promoted-from-orphan reply serves photos via source_unmatched_id (migration 145)', async () => {
    const pool = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [] }) // reply_inbox_attachments empty
      .mockResolvedValueOnce({ rows: [{ attachments_meta: null, source_unmatched_id: 557 }] }) // reply_inbox row links to orphan
      .mockResolvedValueOnce({ rows: [{ idx: 0, filename: 'foto.jpg', content_type: 'image/jpeg', size_bytes: 9, sha256: 'x', is_inline: true }] }) } // unmatched_inbound_attachments
    const res = await request(await makeApp(pool)).get('/api/replies/300/attachments')
    expect(res.status).toBe(200)
    expect(res.body.source).toBe('reply_inbox_via_unmatched')
    expect(res.body.attachments[0].filename).toBe('foto.jpg')
    expect(pool.query.mock.calls[2][1]).toEqual([557]) // queried by source_unmatched_id
  })
})

describe('GET /api/messages/:id/attachments/:idx (matched bytes)', () => {
  it('streams from reply_inbox_attachments by (reply_inbox_id, idx)', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ filename: 'f.jpg', content_type: 'image/jpeg', size_bytes: 3, data: Buffer.from([0xff, 0xd8, 0xff]), sha256: 'abc', is_inline: true }] }) }
    const res = await request(await makeApp(pool)).get('/api/messages/97/attachments/0')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('image/jpeg')
    expect(pool.query.mock.calls[0][0]).toMatch(/reply_inbox_attachments/)
    expect(pool.query.mock.calls[0][1]).toEqual([97, 0])
  })
})
