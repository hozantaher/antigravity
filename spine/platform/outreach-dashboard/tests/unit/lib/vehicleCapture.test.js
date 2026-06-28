import { describe, it, expect, vi } from 'vitest'
import {
  bareEmail,
  captureVehiclesFromReply,
  CAPTURE_MIN_CONFIDENCE,
  CAPTURE_MAX_PER_REPLY,
} from '../../../src/lib/vehicleCapture.js'

// A fake pg pool that routes by SQL substring. No dedup hits by default, every
// INSERT returns a fresh id, lookups return no contact, crm upsert returns id 1.
function makePool({ existingDup = false } = {}) {
  let nextId = 100
  const calls = { inserts: 0, audits: 0, dupChecks: 0 }
  const query = vi.fn(async (sql) => {
    if (/FROM vehicles\s+WHERE source_reply_id/i.test(sql)) {
      calls.dupChecks++
      return { rows: existingDup ? [{ id: 1 }] : [] }
    }
    if (/INSERT INTO vehicles/i.test(sql)) {
      calls.inserts++
      return { rows: [{ id: nextId++, make: 'X', model: 'Y' }] }
    }
    if (/INSERT INTO operator_audit_log/i.test(sql)) {
      calls.audits++
      return { rows: [] }
    }
    if (/FROM contacts/i.test(sql)) return { rows: [] }
    if (/FROM crm_clients/i.test(sql)) return { rows: [] }
    if (/INSERT INTO crm_clients/i.test(sql)) return { rows: [{ id: 1 }] }
    return { rows: [] }
  })
  return { query, calls }
}

describe('bareEmail', () => {
  it('extracts from a decorated header', () => {
    expect(bareEmail('Jan Novák <Jan@Firma.CZ>')).toBe('jan@firma.cz')
  })
  it('lowercases a bare address', () => {
    expect(bareEmail('Foo@Bar.com')).toBe('foo@bar.com')
  })
  it('returns empty for nullish', () => {
    expect(bareEmail(null)).toBe('')
    expect(bareEmail(undefined)).toBe('')
  })
})

describe('captureVehiclesFromReply', () => {
  it('inserts a vehicle found in the body + audits it', async () => {
    const pool = makePool()
    const out = await captureVehiclesFromReply(pool, {
      replyId: 42,
      fromEmail: 'prodejce@seznam.cz',
      subject: 'Re: Poptávka',
      body: 'Nabízím Caterpillar 312 kolový bagr, rok 2015, najeto 5000 motohodin.',
    })
    expect(out.inserted).toBeGreaterThanOrEqual(1)
    expect(pool.calls.inserts).toBe(out.inserted)
    expect(pool.calls.audits).toBe(out.inserted) // every insert audited
  })

  it('returns zeros for a body with no vehicle', async () => {
    const pool = makePool()
    const out = await captureVehiclesFromReply(pool, {
      replyId: 1,
      fromEmail: 'x@y.cz',
      body: 'Dobrý den, děkuji, nemám zájem. S pozdravem.',
    })
    expect(out).toEqual({ inserted: 0, skipped: 0, candidates: 0 })
    expect(pool.calls.inserts).toBe(0)
  })

  it('skips (does not insert) when the vehicle is already captured', async () => {
    const pool = makePool({ existingDup: true })
    const out = await captureVehiclesFromReply(pool, {
      replyId: 7,
      fromEmail: 'a@b.cz',
      body: 'Prodám Ford Transit 2015.',
    })
    expect(out.inserted).toBe(0)
    expect(out.skipped).toBeGreaterThanOrEqual(1)
    expect(pool.calls.inserts).toBe(0)
  })

  it('never inserts more than CAPTURE_MAX_PER_REPLY vehicles', async () => {
    const pool = makePool()
    // A digest naming many machines — capture must cap the insert count.
    const body = Array.from({ length: 12 }, (_, i) =>
      `Caterpillar ${300 + i} bagr rok ${2000 + i}`).join('. ')
    const out = await captureVehiclesFromReply(pool, { replyId: 9, fromEmail: 'x@y.cz', body })
    expect(out.candidates).toBeLessThanOrEqual(CAPTURE_MAX_PER_REPLY)
    expect(out.inserted).toBeLessThanOrEqual(CAPTURE_MAX_PER_REPLY)
  })

  it('exposes sane named thresholds', () => {
    expect(CAPTURE_MIN_CONFIDENCE).toBeGreaterThan(0)
    expect(CAPTURE_MIN_CONFIDENCE).toBeLessThanOrEqual(1)
    expect(CAPTURE_MAX_PER_REPLY).toBeGreaterThanOrEqual(1)
  })

  it('handles a missing/empty body without throwing', async () => {
    const pool = makePool()
    const out = await captureVehiclesFromReply(pool, { replyId: 5, fromEmail: 'a@b.cz', body: '' })
    expect(out.inserted).toBe(0)
  })

  it('captures a make-only offer (model NULL) — must not be dropped', async () => {
    // "Mercedes Vito 2003 200 000" yields make=Mercedes, model=null after the
    // numeric-fragment guard. Before migration 142 (model NOT NULL) this INSERT
    // threw 23502 and the cron swallowed it, silently losing the lead.
    const pool = makePool()
    const out = await captureVehiclesFromReply(pool, {
      replyId: 11,
      fromEmail: 'prodej@seznam.cz',
      body: 'Můžu prodat Mercedes Vito 2003 200 000 tachometr',
    })
    expect(out.inserted).toBeGreaterThanOrEqual(1)
    // the INSERT must have been issued with a null model param
    const insertCall = pool.query.mock.calls.find(([sql]) => /INSERT INTO vehicles/i.test(sql))
    expect(insertCall).toBeTruthy()
    const params = insertCall[1]
    expect(params[0]).toBe('Mercedes') // make
    expect(params[1]).toBeNull()       // model
  })
})
