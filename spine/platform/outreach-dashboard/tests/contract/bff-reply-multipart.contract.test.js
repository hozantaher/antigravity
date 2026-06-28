// bff-reply-multipart.contract.test.js
//
// POST /api/replies/:id/reply — operator reply with optional attachments.
//
// REGRESSION GUARD for the "Unexpected end of form" bug: the route used to run
// its OWN Busboy via req.pipe(), which fought the app-global express-fileupload
// middleware for the single-consumption request stream. express-fileupload
// drained the body first, the route's parser then saw EOF and threw "Unexpected
// end of form" → EVERY send returned HTTP 400. This test mounts the SAME
// middleware stack as production (express.json + express-fileupload) so a
// regression re-breaks it here instead of in the operator's face.
//
// feedback_extreme_testing — this is a send-path-adjacent mutation endpoint, so
// it gets the full input spectrum (happy paths, validation, auth-shape, orphan
// promotion), not just one happy case.

import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import fileUpload from 'express-fileupload'
import request from 'supertest'

// A pooled client whose query() answers by SQL shape, so assertions don't
// depend on call ordering. Attachment INSERTs hand back incrementing ids.
function makeClient({ replyRow = { id: 391, handled: false } } = {}) {
  let attId = 9000
  const query = vi.fn(async (sql) => {
    if (/SELECT id, handled FROM reply_inbox/i.test(sql)) {
      return { rows: replyRow ? [replyRow] : [] }
    }
    if (/INSERT INTO manual_reply_outbox_attachments/i.test(sql)) {
      return { rows: [{ id: ++attId }] }
    }
    if (/INSERT INTO manual_reply_outbox\b/i.test(sql)) {
      return { rows: [{ id: 5001 }] }
    }
    if (/SELECT from_address, subject, received_at, reviewed[\s\S]*FROM unmatched_inbound/i.test(sql)) {
      return { rows: [{ from_address: 'a@b.cz', subject: 'Re: x', received_at: new Date(0), reviewed: false }] }
    }
    if (/INSERT INTO reply_inbox\b/i.test(sql)) {
      return { rows: [{ id: 700 }] }
    }
    // BEGIN / COMMIT / ROLLBACK / UPDATE reply_inbox / UPDATE unmatched_inbound
    return { rows: [] }
  })
  return { query, release: vi.fn() }
}

async function makeApp(client) {
  const app = express()
  // Mirror production middleware order (server.js): json THEN fileupload.
  app.use(express.json({ limit: '1mb' }))
  app.use(fileUpload({
    limits: { fileSize: 10 * 1024 * 1024 },
    abortOnLimit: true,
    useTempFiles: false,
    createParentPath: false,
  }))
  const pool = { connect: vi.fn(async () => client) }
  const { mountReplyMultipartRoutes } = await import('../../src/server-routes/replyMultipart.js')
  mountReplyMultipartRoutes(app, {
    pool,
    capture500: (res, e) => res.status(500).json({ error: e.message }),
    safeError: (e) => e,
  })
  return { app, pool }
}

describe('POST /api/replies/:id/reply (multipart, behind express-fileupload)', () => {
  it('REGRESSION: body-only send succeeds through the full middleware stack', async () => {
    const client = makeClient()
    const { app } = await makeApp(client)
    const res = await request(app)
      .post('/api/replies/391/reply')
      .field('body', 'Dobrý den, ozývám se k vašemu dotazu.')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.outbox_id).toBe(5001)
    expect(res.body.attachments).toEqual([])
    // outbox INSERT got the trimmed body + reply id
    const outboxCall = client.query.mock.calls.find(([s]) => /INSERT INTO manual_reply_outbox\b/i.test(s))
    expect(outboxCall[1]).toEqual(['Dobrý den, ozývám se k vašemu dotazu.', 391])
    // reply_inbox flipped to handled, client released exactly once
    expect(client.query.mock.calls.some(([s]) => /UPDATE reply_inbox SET handled = TRUE/i.test(s))).toBe(true)
    expect(client.release).toHaveBeenCalledTimes(1)
  })

  it('accepts a single image attachment (req.files.files = single object)', async () => {
    const client = makeClient()
    const { app } = await makeApp(client)
    const res = await request(app)
      .post('/api/replies/391/reply')
      .field('body', 'Foto v příloze.')
      .attach('files', Buffer.from([0xff, 0xd8, 0xff, 0xe0]), { filename: 'foto.jpg', contentType: 'image/jpeg' })
    expect(res.status).toBe(200)
    expect(res.body.attachments).toHaveLength(1)
    const attCall = client.query.mock.calls.find(([s]) => /INSERT INTO manual_reply_outbox_attachments/i.test(s))
    expect(attCall[1][2]).toBe('foto.jpg')             // filename
    expect(attCall[1][3]).toBe('image/jpeg')           // content_type
    expect(Buffer.isBuffer(attCall[1][5])).toBe(true)  // data is a real Buffer
    expect(attCall[1][7]).toBe(true)                   // is_inline (image/*)
  })

  it('accepts multiple attachments (req.files.files = array)', async () => {
    const client = makeClient()
    const { app } = await makeApp(client)
    const res = await request(app)
      .post('/api/replies/391/reply')
      .field('body', 'Dva soubory.')
      .attach('files', Buffer.from('PDFDATA'), { filename: 'a.pdf', contentType: 'application/pdf' })
      .attach('files', Buffer.from([0x89, 0x50, 0x4e, 0x47]), { filename: 'b.png', contentType: 'image/png' })
    expect(res.status).toBe(200)
    expect(res.body.attachments).toHaveLength(2)
  })

  it('400 "body required" when text is missing (file but no body field)', async () => {
    const client = makeClient()
    const { app, pool } = await makeApp(client)
    const res = await request(app)
      .post('/api/replies/391/reply')
      .attach('files', Buffer.from('x'), { filename: 'a.pdf', contentType: 'application/pdf' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/body required/)
    expect(pool.connect).not.toHaveBeenCalled() // rejected before any DB work
  })

  it('400 on unsupported attachment MIME, before opening a DB connection', async () => {
    const client = makeClient()
    const { app, pool } = await makeApp(client)
    const res = await request(app)
      .post('/api/replies/391/reply')
      .field('body', 'pokus')
      .attach('files', Buffer.from('MZ'), { filename: 'evil.exe', contentType: 'application/octet-stream' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/unsupported content_type/)
    expect(pool.connect).not.toHaveBeenCalled()
  })

  it('400 when more than MAX_FILES (3) attachments', async () => {
    const client = makeClient()
    const { app } = await makeApp(client)
    const req = request(app).post('/api/replies/391/reply').field('body', 'moc')
    for (let i = 0; i < 4; i++) {
      req.attach('files', Buffer.from('x'), { filename: `f${i}.pdf`, contentType: 'application/pdf' })
    }
    const res = await req
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/too many files/)
  })

  it('415 when the request is not multipart (JSON body)', async () => {
    const client = makeClient()
    const { app } = await makeApp(client)
    const res = await request(app)
      .post('/api/replies/391/reply')
      .send({ body: 'tohle je json' })
    expect(res.status).toBe(415)
    expect(res.body.error).toMatch(/multipart/)
  })

  it('400 on a non-numeric id', async () => {
    const client = makeClient()
    const { app } = await makeApp(client)
    const res = await request(app)
      .post('/api/replies/abc/reply')
      .field('body', 'x')
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/invalid reply id/)
  })

  it('404 when the reply_inbox row is missing', async () => {
    const client = makeClient({ replyRow: null })
    const { app } = await makeApp(client)
    const res = await request(app)
      .post('/api/replies/391/reply')
      .field('body', 'x')
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/reply not found/)
    // 404 branch must release the client exactly once (no double-release).
    expect(client.release).toHaveBeenCalledTimes(1)
  })

  it('negative id promotes an unmatched_inbound orphan, then queues the reply', async () => {
    const client = makeClient()
    const { app } = await makeApp(client)
    const res = await request(app)
      .post('/api/replies/-557/reply')
      .field('body', 'odpověď na orphan')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(client.query.mock.calls.some(([s]) => /INSERT INTO reply_inbox\b/i.test(s))).toBe(true)
    expect(client.query.mock.calls.some(([s]) => /UPDATE unmatched_inbound SET reviewed = TRUE/i.test(s))).toBe(true)
    expect(client.release).toHaveBeenCalledTimes(1)
  })
})
