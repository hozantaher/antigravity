// bff-reply-forward.contract.test.js
//
// POST /api/replies/:id/forward — operator "Přeposlat" (forward an inbound
// reply to a third-party address through the real send path).
//
// The route enqueues a kind='forward' manual_reply_outbox row (recipient
// override in forward_to, sending identity in from_mailbox_id) that the
// outbound-reply dispatcher ships via anti-trace-relay. This contract pins the
// enqueue shape: Fwd subject, quoted body, recipient override, attachment copy,
// audit row, and the validation/anti-loop guards.
//
// feedback_extreme_testing — send-path-adjacent mutation → full input spectrum.

import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import fileUpload from 'express-fileupload'
import request from 'supertest'

// A pooled client that answers by SQL shape so assertions don't depend on call
// ordering. Note the \b trick: /manual_reply_outbox\b/ does NOT match
// manual_reply_outbox_attachments ('_' is a word char → no boundary).
function makeClient(opts = {}) {
  const {
    original = {
      id: 391, from_email: 'lead@firma.cz', subject: 'Dotaz na bagr',
      received_at: new Date(0), body_text: 'Mám zájem o ten bagr.', mailbox_id: 33,
    },
    mailbox = { id: 33, from_address: 'sender@seznam.cz' },
    attachments = [],
    unmatched = {
      from_address: 'orphan@x.cz', subject: 'Orphan', received_at: new Date(0),
      body_preview: 'orphan body', reviewed: false,
    },
    activeMailbox = { id: 7, from_address: 'active@seznam.cz' },
  } = opts
  let attId = 9000
  const query = vi.fn(async (sql) => {
    if (/FROM reply_inbox WHERE id/i.test(sql)) return { rows: original ? [original] : [] }
    if (/FROM unmatched_inbound WHERE id/i.test(sql)) return { rows: unmatched ? [unmatched] : [] }
    if (/INSERT INTO reply_inbox\b/i.test(sql)) return { rows: [{ id: 700 }] }
    if (/FROM outreach_mailboxes WHERE id/i.test(sql)) return { rows: mailbox ? [mailbox] : [] }
    if (/FROM outreach_mailboxes WHERE status = 'active'/i.test(sql)) return { rows: activeMailbox ? [activeMailbox] : [] }
    if (/FROM reply_inbox_attachments/i.test(sql)) return { rows: attachments }
    if (/INSERT INTO manual_reply_outbox_attachments/i.test(sql)) return { rows: [{ id: ++attId }] }
    if (/INSERT INTO manual_reply_outbox\b/i.test(sql)) return { rows: [{ id: 5001 }] }
    // BEGIN / COMMIT / ROLLBACK / INSERT operator_audit_log / UPDATE …
    return { rows: [] }
  })
  return { query, release: vi.fn() }
}

async function makeApp(client) {
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.use(fileUpload({ limits: { fileSize: 10 * 1024 * 1024 }, abortOnLimit: true, useTempFiles: false }))
  const pool = { connect: vi.fn(async () => client) }
  const { mountReplyForwardRoutes } = await import('../../src/server-routes/replyForward.js')
  mountReplyForwardRoutes(app, {
    pool,
    capture500: (res, e) => res.status(500).json({ error: e.message }),
    safeError: (e) => e,
  })
  return { app, pool }
}

const call = (sql) => ([s]) => sql.test(s)

describe('POST /api/replies/:id/forward', () => {
  it('happy path (JSON): enqueues a kind=forward row with Fwd subject + quoted body', async () => {
    const client = makeClient()
    const { app } = await makeApp(client)
    const res = await request(app)
      .post('/api/replies/391/forward')
      .send({ to: 'dealer@bagry.cz', note: 'Pošli nabídku.' })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.outbox_id).toBe(5001)
    expect(res.body.recipient_domain).toBe('bagry.cz')

    const outboxCall = client.query.mock.calls.find(call(/INSERT INTO manual_reply_outbox\b/i))
    const [body, replyInboxId, subjectOverride, forwardTo, fromMailboxId] = outboxCall[1]
    expect(replyInboxId).toBe(391)
    expect(subjectOverride).toBe('Fwd: Dotaz na bagr')
    expect(forwardTo).toBe('dealer@bagry.cz')
    expect(fromMailboxId).toBe(33)
    expect(body).toContain('Pošli nabídku.')
    expect(body).toContain('Přeposlaná zpráva')
    expect(body).toContain('Mám zájem o ten bagr.')
  })

  it('writes operator_audit_log (PII-light: domain only) in the same tx', async () => {
    const client = makeClient()
    const { app } = await makeApp(client)
    await request(app).post('/api/replies/391/forward').send({ to: 'dealer@bagry.cz' })

    const auditCall = client.query.mock.calls.find(call(/INSERT INTO operator_audit_log/i))
    expect(auditCall).toBeTruthy()
    expect(auditCall[1][0]).toBe('reply_forwarded')
    const details = JSON.parse(auditCall[1][4])
    expect(details.recipient_domain).toBe('bagry.cz')
    expect(JSON.stringify(details)).not.toContain('dealer@bagry.cz') // no full address
    // COMMIT happened, client released once.
    expect(client.query.mock.calls.some(call(/COMMIT/i))).toBe(true)
    expect(client.release).toHaveBeenCalledTimes(1)
  })

  it('copies original attachments when include_original is not false', async () => {
    const client = makeClient({
      attachments: [{ idx: 0, filename: 'foto.jpg', content_type: 'image/jpeg', size_bytes: 3, data: Buffer.from([1, 2, 3]), sha256: 'abc', is_inline: true }],
    })
    const { app } = await makeApp(client)
    const res = await request(app).post('/api/replies/391/forward').send({ to: 'dealer@bagry.cz' })
    expect(res.body.attachments).toBe(1)
    const attCall = client.query.mock.calls.find(call(/INSERT INTO manual_reply_outbox_attachments/i))
    expect(attCall[1][2]).toBe('foto.jpg')
    expect(Buffer.isBuffer(attCall[1][5])).toBe(true)
  })

  it('include_original=false skips attachment copy', async () => {
    const client = makeClient({
      attachments: [{ idx: 0, filename: 'foto.jpg', content_type: 'image/jpeg', size_bytes: 3, data: Buffer.from([1, 2, 3]), sha256: 'abc', is_inline: true }],
    })
    const { app } = await makeApp(client)
    const res = await request(app).post('/api/replies/391/forward').send({ to: 'dealer@bagry.cz', include_original: 'false' })
    expect(res.body.attachments).toBe(0)
    expect(client.query.mock.calls.some(call(/INSERT INTO manual_reply_outbox_attachments/i))).toBe(false)
  })

  it('accepts multipart form fields too (FormData from the composer)', async () => {
    const client = makeClient()
    const { app } = await makeApp(client)
    const res = await request(app)
      .post('/api/replies/391/forward')
      .field('to', 'dealer@bagry.cz')
      .field('note', 'multipart note')
    expect(res.status).toBe(200)
    const outboxCall = client.query.mock.calls.find(call(/INSERT INTO manual_reply_outbox\b/i))
    expect(outboxCall[1][0]).toContain('multipart note')
  })

  it('400 when recipient is missing', async () => {
    const client = makeClient()
    const { app, pool } = await makeApp(client)
    const res = await request(app).post('/api/replies/391/forward').send({ note: 'x' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/recipient .*required/)
    expect(pool.connect).not.toHaveBeenCalled() // rejected before DB work
  })

  it('400 on an invalid recipient email', async () => {
    const client = makeClient()
    const { app, pool } = await makeApp(client)
    const res = await request(app).post('/api/replies/391/forward').send({ to: 'notanemail' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/invalid recipient/)
    expect(pool.connect).not.toHaveBeenCalled()
  })

  it('400 on a non-numeric id', async () => {
    const client = makeClient()
    const { app } = await makeApp(client)
    const res = await request(app).post('/api/replies/abc/forward').send({ to: 'dealer@bagry.cz' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/invalid reply id/)
  })

  it('400 anti-loop: cannot forward to the sending mailbox', async () => {
    const client = makeClient() // mailbox.from_address = sender@seznam.cz
    const { app } = await makeApp(client)
    const res = await request(app).post('/api/replies/391/forward').send({ to: 'sender@seznam.cz' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/sending mailbox/)
    expect(client.release).toHaveBeenCalledTimes(1) // rolled back + released
  })

  it('404 when the reply row is missing', async () => {
    const client = makeClient({ original: null, unmatched: null })
    const { app } = await makeApp(client)
    const res = await request(app).post('/api/replies/391/forward').send({ to: 'dealer@bagry.cz' })
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/reply not found/)
    expect(client.release).toHaveBeenCalledTimes(1)
  })

  it('falls back to a default active mailbox when the reply has no mailbox_id', async () => {
    const client = makeClient({
      original: { id: 391, from_email: 'lead@firma.cz', subject: 'Dotaz', received_at: new Date(0), body_text: 'text', mailbox_id: null },
    })
    const { app } = await makeApp(client)
    const res = await request(app).post('/api/replies/391/forward').send({ to: 'dealer@bagry.cz' })
    expect(res.status).toBe(200)
    const outboxCall = client.query.mock.calls.find(call(/INSERT INTO manual_reply_outbox\b/i))
    expect(outboxCall[1][4]).toBe(7) // from_mailbox_id = default active mailbox id
  })

  it('negative id promotes an unmatched orphan, then forwards it', async () => {
    const client = makeClient()
    const { app } = await makeApp(client)
    const res = await request(app).post('/api/replies/-557/forward').send({ to: 'dealer@bagry.cz' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(client.query.mock.calls.some(call(/INSERT INTO reply_inbox\b/i))).toBe(true)
    expect(client.query.mock.calls.some(call(/UPDATE unmatched_inbound SET reviewed = TRUE/i))).toBe(true)
    // Promoted orphan forwards from the default active mailbox (orphan has no mailbox_id).
    const outboxCall = client.query.mock.calls.find(call(/INSERT INTO manual_reply_outbox\b/i))
    expect(outboxCall[1][4]).toBe(7)
  })
})
