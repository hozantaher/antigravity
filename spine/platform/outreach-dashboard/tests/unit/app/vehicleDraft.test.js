/**
 * vehicleDraft — Odpovědi → Vozidlo capture payload builder.
 * Spustit: cd features/platform/outreach-dashboard && pnpm test tests/unit/vehicleDraft
 */
import { describe, it, expect } from 'vitest'
import { draftFromCandidate, isDraftValid, buildCreatePayload, photoRefsFromAttachments } from '../../../src/app/lib/vehicleDraft'

describe('draftFromCandidate', () => {
  it('seeds string fields from an LLM candidate', () => {
    const d = draftFromCandidate({ make: 'Liebherr', model: '922', year: 2015, mileage_km: 1850, price_offered_eur: 45000, body_type: 'bagr' })
    expect(d).toEqual({ make: 'Liebherr', model: '922', year: '2015', mileage_km: '1850', price_offered_eur: '45000', body_type: 'bagr' })
  })
  it('produces all-empty draft from null (manual entry)', () => {
    expect(draftFromCandidate(null)).toEqual({ make: '', model: '', year: '', mileage_km: '', price_offered_eur: '', body_type: '' })
  })
})

describe('isDraftValid', () => {
  it('requires make AND model', () => {
    expect(isDraftValid({ make: 'Iveco', model: 'Daily' })).toBe(true)
    expect(isDraftValid({ make: 'Iveco', model: '' })).toBe(false)
    expect(isDraftValid({ make: '  ', model: 'Daily' })).toBe(false)
    expect(isDraftValid(null)).toBe(false)
  })
})

describe('buildCreatePayload', () => {
  const reply = { id: 97, from_email: 'seller@example.cz' }
  it('parses numerics, drops blanks/zeros to null, carries source linkage', () => {
    const d = { make: ' Mercedes ', model: ' Sprinter ', year: '2018', mileage_km: '280 000', price_offered_eur: '12000', body_type: 'dodávka' }
    expect(buildCreatePayload(d, reply)).toEqual({
      make: 'Mercedes', model: 'Sprinter', year: 2018, mileage_km: 280000,
      price_offered_eur: 12000, body_type: 'dodávka', status: 'offered',
      source_reply_id: 97, source_reply_email: 'seller@example.cz', photos: [],
    })
  })
  it('attaches image photo refs from the reply', () => {
    const photos = [{ source: 'reply', reply_id: 97, idx: 0, filename: 'a.jpg', content_type: 'image/jpeg', url: '/api/messages/97/attachments/0' }]
    expect(buildCreatePayload({ make: 'A', model: 'B' }, reply, photos).photos).toEqual(photos)
  })
  it('blank/zero/non-numeric → null (cleared field means unknown, never 0)', () => {
    const d = { make: 'Ford', model: 'Transit', year: '', mileage_km: '0', price_offered_eur: 'abc', body_type: '' }
    const p = buildCreatePayload(d, reply)
    expect(p.year).toBeNull()
    expect(p.mileage_km).toBeNull()
    expect(p.price_offered_eur).toBeNull()
    expect(p.body_type).toBeNull()
    expect(p.status).toBe('offered')
  })
  it('tolerates a null reply (no linkage)', () => {
    const p = buildCreatePayload({ make: 'A', model: 'B' }, null)
    expect(p.source_reply_id).toBeNull()
    expect(p.source_reply_email).toBeNull()
    expect(p.photos).toEqual([])
  })
})

describe('photoRefsFromAttachments', () => {
  it('keeps only image/* attachments and builds servable refs', () => {
    const atts = [
      { idx: 0, filename: 'foto.jpg', content_type: 'image/jpeg' },
      { idx: 1, filename: 'doc.pdf', content_type: 'application/pdf' },
      { idx: 2, filename: 'p.png', content_type: 'image/png' },
    ]
    const refs = photoRefsFromAttachments(-557, atts)
    expect(refs).toHaveLength(2)
    expect(refs[0]).toEqual({ source: 'reply', reply_id: -557, idx: 0, filename: 'foto.jpg', content_type: 'image/jpeg', url: '/api/messages/-557/attachments/0' })
    expect(refs[1].idx).toBe(2)
  })
  it('returns [] for null/empty', () => {
    expect(photoRefsFromAttachments(null, [])).toEqual([])
    expect(photoRefsFromAttachments(1, null)).toEqual([])
  })
})
