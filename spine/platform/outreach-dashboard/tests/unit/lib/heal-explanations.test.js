// SHARED-5 — heal-explanations tests (TDD RED first).

import { describe, it, expect } from 'vitest'
import {
  renderHealExplanation,
  parseHealLog,
  validateExplanation,
} from '../../../src/lib/heal-explanations.js'

describe('renderHealExplanation', () => {
  it('renders auto_pause action in Czech', () => {
    const text = renderHealExplanation({
      action: 'auto_pause',
      entity_type: 'mailbox',
      entity_id: 3,
      entity_label: 'a.mazher@email.cz',
      reason: '3× SMTP 535 v 8 minutách',
      threshold: { failures: 3, window_min: 8 },
      next_step: 'Cooldown 30 min, poté auto_resume',
      probable_cause: 'Rotace přihlašovacích údajů na seznam.cz',
    })
    expect(text).toMatch(/Pozastaveno/)
    expect(text).toMatch(/mb=3/)
    expect(text).toMatch(/SMTP 535/)
    expect(text).toMatch(/Cooldown 30 min/)
    expect(text).toMatch(/seznam.cz/)
  })

  it('renders auto_resume action', () => {
    const text = renderHealExplanation({
      action: 'auto_resume',
      entity_type: 'mailbox',
      entity_id: 3,
      reason: 'Cooldown vypršel',
      next_step: 'Sledování dalších 3 odeslání',
    })
    expect(text).toMatch(/Obnoveno/)
    expect(text).toMatch(/mb=3/)
  })

  it('renders engine_restart with root cause hypothesis', () => {
    const text = renderHealExplanation({
      action: 'engine_restart',
      entity_type: 'engine',
      entity_id: 'sender_daemon',
      reason: 'panic: anti-trace down',
      probable_cause: 'Anti-trace relay 503 cascade',
    })
    expect(text).toMatch(/Restart/)
    expect(text).toMatch(/sender_daemon/)
    expect(text).toMatch(/Anti-trace/)
  })

  it('renders cron_recovery action', () => {
    const text = renderHealExplanation({
      action: 'cron_recovery',
      entity_type: 'cron',
      entity_id: 'fullCheck',
      reason: 'Předchozí tick selhal',
      next_step: 'Příští tick za 12 minut',
    })
    expect(text).toMatch(/Cron/)
    expect(text).toMatch(/fullCheck/)
  })

  it('renders manual_review_required (escalation terminal)', () => {
    const text = renderHealExplanation({
      action: 'manual_review_required',
      entity_type: 'mailbox',
      entity_id: 3,
      reason: '3 cykly auto_pause/resume v 30 min',
      next_step: 'Vyžaduje ruční ACK od operátora',
    })
    expect(text).toMatch(/ruční/i)
    expect(text).toMatch(/eskalace|Eskalace|MANUAL/i)
  })

  it('handles missing optional fields gracefully', () => {
    const text = renderHealExplanation({
      action: 'auto_pause',
      entity_type: 'mailbox',
      entity_id: 5,
      reason: 'breaker tripped',
    })
    expect(text).toMatch(/Pozastaveno/)
    expect(text).not.toMatch(/undefined/)
  })

  it('throws on unknown action', () => {
    expect(() => renderHealExplanation({ action: 'unknown_xyz', entity_type: 'mailbox', entity_id: 1, reason: 'x' }))
      .toThrow(/unknown action/i)
  })

  it('throws on missing required fields', () => {
    expect(() => renderHealExplanation({ action: 'auto_pause' })).toThrow(/required/i)
  })

  it('output is single-line by default (suitable for log)', () => {
    const text = renderHealExplanation({
      action: 'auto_pause',
      entity_type: 'mailbox',
      entity_id: 1,
      reason: 'x',
    })
    expect(text.includes('\n')).toBe(false)
  })

  it('multi_line option splits to readable paragraphs', () => {
    const text = renderHealExplanation({
      action: 'auto_pause',
      entity_type: 'mailbox',
      entity_id: 1,
      reason: 'x',
      next_step: 'y',
      probable_cause: 'z',
    }, { multiline: true })
    expect(text.split('\n').length).toBeGreaterThan(1)
  })
})

describe('parseHealLog', () => {
  it('parses healing_log row to structured action', () => {
    const row = {
      id: 1,
      entity_type: 'mailbox',
      entity_id: 3,
      entity_label: 'a@b.cz',
      action: 'auto_pause',
      reason: '3× SMTP failures',
      resolved_at: null,
      created_at: '2026-04-26T10:00:00Z',
    }
    const parsed = parseHealLog(row)
    expect(parsed.action).toBe('auto_pause')
    expect(parsed.entity_id).toBe(3)
    expect(parsed.is_open).toBe(true)
  })

  it('marks resolved when resolved_at present', () => {
    const row = {
      id: 1, entity_type: 'mailbox', entity_id: 3, entity_label: 'a@b.cz',
      action: 'auto_pause', reason: 'x',
      resolved_at: '2026-04-26T10:30:00Z',
      created_at: '2026-04-26T10:00:00Z',
    }
    const parsed = parseHealLog(row)
    expect(parsed.is_open).toBe(false)
    expect(parsed.duration_ms).toBe(30 * 60 * 1000)
  })

  it('throws on malformed row missing required fields', () => {
    expect(() => parseHealLog({})).toThrow(/required|missing/i)
  })

  it('handles array of rows', () => {
    const rows = [
      { id: 1, entity_type: 'mb', entity_id: 1, action: 'a', reason: 'r', created_at: '2026-01-01' },
      { id: 2, entity_type: 'mb', entity_id: 1, action: 'b', reason: 'r', created_at: '2026-01-02' },
    ]
    expect(parseHealLog(rows).length).toBe(2)
  })
})

describe('validateExplanation — discipline check helper', () => {
  it('passes when explanation includes all 5 required signals', () => {
    const text = 'Pozastaveno mb=3 (3× SMTP 535 v 8 min). Cooldown 30 min, poté auto_resume. Pravděpodobná příčina: rotace přihlášení.'
    const v = validateExplanation(text, { actionVerb: 'Pozastaveno', entityRef: 'mb=3', reason: 'SMTP 535', nextStep: 'Cooldown', cause: 'rotace' })
    expect(v.ok).toBe(true)
    expect(v.missing).toEqual([])
  })

  it('reports missing signals', () => {
    const text = 'Pozastaveno mb=3.'
    const v = validateExplanation(text, { actionVerb: 'Pozastaveno', entityRef: 'mb=3', reason: 'SMTP', nextStep: 'X', cause: 'Y' })
    expect(v.ok).toBe(false)
    expect(v.missing).toContain('reason')
    expect(v.missing.length).toBeGreaterThan(0)
  })

  it('handles non-string input safely', () => {
    expect(validateExplanation(null, { actionVerb: 'X', entityRef: 'Y', reason: 'Z', nextStep: 'W', cause: 'V' }).ok).toBe(false)
    expect(validateExplanation(undefined, {}).ok).toBe(false)
  })
})
