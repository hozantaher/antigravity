// MVP-5 — template-preview pure-fn tests.

import { describe, it, expect } from 'vitest'
import { renderTemplatePreview } from '../../../src/lib/template-preview.js'

describe('renderTemplatePreview — substitution', () => {
  it('T-1: substitutes known merge tags from default sample', () => {
    const r = renderTemplatePreview('Ahoj {{jmeno}}', 'Vaše firma {{firma}}. /unsubscribe', {})
    expect(r.subject).toBe('Ahoj Pavel Novák')
    expect(r.body).toContain('AKB Stavby')
  })

  it('T-2: caller-supplied sample overrides defaults', () => {
    const r = renderTemplatePreview('{{jmeno}}', 'x /unsubscribe', { jmeno: 'Eva' })
    expect(r.subject).toBe('Eva')
  })

  it('T-3: explicit undefined in sample renders empty (operator opt-out for that var)', () => {
    const r = renderTemplatePreview('{{jmeno}}', 'x /unsubscribe', { jmeno: undefined })
    // SAMPLE_DEFAULTS gets overridden by explicit undefined → empty render
    expect(r.subject).toBe('')
  })

  it('T-4: case-insensitive merge tags (matches operator typos)', () => {
    const r = renderTemplatePreview('{{JMENO}}', 'b /unsubscribe', { jmeno: 'X' })
    expect(r.subject).toBe('X')
  })

  it('T-5: used_vars includes every recognized substitution', () => {
    const r = renderTemplatePreview('{{jmeno}} {{firma}}', '{{region}} /unsubscribe', {})
    expect(r.used_vars.sort()).toEqual(['firma', 'jmeno', 'region'])
  })
})

describe('renderTemplatePreview — warnings', () => {
  it('T-6: empty subject warns at error level', () => {
    const r = renderTemplatePreview('', 'body /unsubscribe', {})
    expect(r.warnings.some(w => w.code === 'empty_subject' && w.level === 'error')).toBe(true)
    expect(r.ok).toBe(false)
  })

  it('T-7: empty body warns at error level', () => {
    const r = renderTemplatePreview('subj', '', {})
    expect(r.warnings.some(w => w.code === 'empty_body')).toBe(true)
    expect(r.ok).toBe(false)
  })

  it('T-8: missing unsubscribe link warns at error level', () => {
    const r = renderTemplatePreview('subj', 'no link here', {})
    expect(r.warnings.some(w => w.code === 'no_unsubscribe')).toBe(true)
    expect(r.ok).toBe(false)
  })

  it('T-9: {{unsubscribe_url}} merge tag satisfies compliance', () => {
    const r = renderTemplatePreview('subj', 'Click {{unsubscribe_url}}', {})
    expect(r.warnings.some(w => w.code === 'no_unsubscribe')).toBe(false)
  })

  it('T-10: literal /unsubscribe path satisfies compliance', () => {
    const r = renderTemplatePreview('subj', 'Visit /unsubscribe?id=...', {})
    expect(r.warnings.some(w => w.code === 'no_unsubscribe')).toBe(false)
  })

  it('T-11: unknown merge tag warns + leaves placeholder verbatim', () => {
    const r = renderTemplatePreview('Hi {{unknown_thing}}', 'b /unsubscribe', {})
    expect(r.warnings.some(w => w.code === 'unknown_merge_tag')).toBe(true)
    expect(r.subject).toContain('{{unknown_thing}}')
  })

  it('T-12: unbalanced {{ warns', () => {
    const r = renderTemplatePreview('Hi {{jmeno', 'b /unsubscribe', {})
    expect(r.warnings.some(w => w.code === 'unbalanced_merge_tag')).toBe(true)
  })

  it('T-13: clean template returns ok=true with zero error-level warnings', () => {
    const r = renderTemplatePreview(
      'Ahoj {{jmeno_zkraceno}}',
      'Vaše firma {{firma_short}} ({{sektor}}). Odhlásit: {{unsubscribe_url}}',
      {},
    )
    expect(r.ok).toBe(true)
    expect(r.warnings.filter(w => w.level === 'error')).toHaveLength(0)
  })
})

describe('renderTemplatePreview — output shape', () => {
  it('T-14: includes plaintext_preview with HTML stripped', () => {
    const r = renderTemplatePreview('s', '<p>hi <b>world</b></p> /unsubscribe', {})
    expect(r.plaintext_preview).not.toContain('<')
    expect(r.plaintext_preview).toContain('hi world')
  })

  it('T-15: plaintext_preview capped at 500 chars', () => {
    const long = 'x'.repeat(2000)
    const r = renderTemplatePreview('s', `${long} /unsubscribe`, {})
    expect(r.plaintext_preview.length).toBeLessThanOrEqual(500)
  })

  it('T-16: returns ok=false when any error-level warning present', () => {
    const r = renderTemplatePreview('', '', {})
    expect(r.ok).toBe(false)
  })

  it('T-17: returns ok=true even with warn-level (unknown var) warnings', () => {
    const r = renderTemplatePreview(
      'Ahoj {{xy}}',
      '{{firma}} /unsubscribe',
      {},
    )
    // Unknown var is warn, not error
    expect(r.warnings.some(w => w.level === 'warn')).toBe(true)
    expect(r.warnings.every(w => w.level !== 'error')).toBe(true)
    expect(r.ok).toBe(true)
  })

  it('T-18: spintax syntax {a|b} is preserved (resolved by Go runner, not preview)', () => {
    const r = renderTemplatePreview(
      '{Ahoj|Dobrý den} {{jmeno}}',
      '{{firma}} /unsubscribe',
      {},
    )
    // Preview leaves spintax untouched — not its job
    expect(r.subject).toMatch(/\{Ahoj\|Dobrý den\}/)
  })
})
