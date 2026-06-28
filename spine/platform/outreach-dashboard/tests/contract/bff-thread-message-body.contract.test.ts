// Contract: GET /api/threads/:id/messages resolves the OUTBOUND (auto_send)
// body from email_templates via the campaign's sequence_config (step → template
// name). Regression for the bug where the outbound bubble showed the SUBJECT
// ("Poptávka") because send_events does not persist the rendered body, so the
// handler fell back to se.subject. (features/platform/outreach-dashboard/src/server-routes/replies.js)

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

const TEMPLATE_BODY = 'Dobry den, rychly dotaz — mate na prodej techniku? Volejte 776 299 933.'

// Pool mock routed by SQL substring so the handler's sequential queries each get
// realistic rows (reply → sends → campaign sequence_config → template body).
vi.mock('pg', () => {
  class Pool {
    async query(text: string) {
      const sql = String(text)
      if (/FROM reply_inbox r WHERE r\.id/.test(sql)) {
        return { rows: [{
          id: '1', send_event_id: '9', campaign_id: '457', contact_id: '5',
          from_email: 'kupec@firma.cz', received_at: '2026-05-28T10:00:00Z',
          subject: 'Poptávka', body_text: 'Mam zajem, ozvete se.', body_html: null,
        }] }
      }
      if (/FROM send_events se/.test(sql)) {
        return { rows: [{ id: '9', step: 0, sent_at: '2026-05-28T08:00:00Z',
          sender_email: 'mb@seznam.cz', subject: 'Poptávka' }] }
      }
      if (/FROM campaigns WHERE id/.test(sql)) {
        return { rows: [{ sequence_config: [{ step: 0, template: 'intro_machinery', delay_days: 0 }] }] }
      }
      if (/FROM email_templates WHERE name = ANY/.test(sql)) {
        return { rows: [{ name: 'intro_machinery', body: TEMPLATE_BODY }] }
      }
      // manual_reply_outbox / outreach_messages / message_attachments / boot probes
      return { rows: [] }
    }
    async connect() {
      const self = this
      return {
        async query(s, p) {
          if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/i.test(typeof s === 'string' ? s : '')) return { rows: [], rowCount: 0 }
          return self.query(s, p)
        },
        release() {},
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
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL']) savedEnv[k] = process.env[k]
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  const mod = await import('../../server.js')
  const { app } = mod as { app: import('express').Express }
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
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

describe('GET /api/threads/:id/messages — outbound body resolution', () => {
  it('auto_send bubble carries the TEMPLATE body, not the subject', async () => {
    const res = await fetch(`${baseUrl}/api/threads/1/messages`)
    expect(res.status).toBe(200)
    const { messages } = await res.json()
    const ours = messages.find((m: { type: string }) => m.type === 'auto_send')
    expect(ours).toBeTruthy()
    expect(ours.body).toBe(TEMPLATE_BODY)
    expect(ours.body_text).toBe(TEMPLATE_BODY)
    // The bug: subject leaked into body. Guard against the regression.
    expect(ours.body).not.toBe('Poptávka')
  })

  it('inbound reply still carries its own body', async () => {
    const res = await fetch(`${baseUrl}/api/threads/1/messages`)
    const { messages } = await res.json()
    const theirs = messages.find((m: { type: string }) => m.type === 'incoming')
    expect(theirs).toBeTruthy()
    expect(theirs.body_text).toBe('Mam zajem, ozvete se.')
  })
})
