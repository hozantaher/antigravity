import { describe, it, expect } from 'vitest'
import { rewriteCidUris, rewriteMessageCids } from '../../../src/lib/cidRewrite.js'

// ════════════════════════════════════════════════════════════════════════
// Brutal coverage for cidRewrite (mail-client S2.1 #199).
// ════════════════════════════════════════════════════════════════════════

describe('rewriteCidUris', () => {
  it('1. rewrites img src="cid:X" to /api/messages/:id/attachments/X', () => {
    const out = rewriteCidUris('<img src="cid:logo-001@example">', 42)
    expect(out).toBe('<img src="/api/messages/42/attachments/logo-001%40example">')
  })

  it('2. rewrites img src=\'cid:X\' (single quotes) too', () => {
    const out = rewriteCidUris("<img src='cid:logo'>", 42)
    expect(out).toBe("<img src='/api/messages/42/attachments/logo'>")
  })

  it('3. rewrites href="cid:X" on anchors', () => {
    const out = rewriteCidUris('<a href="cid:doc">PDF</a>', 7)
    expect(out).toBe('<a href="/api/messages/7/attachments/doc">PDF</a>')
  })

  it('4. is case-insensitive on cid: scheme', () => {
    const out = rewriteCidUris('<img src="CID:LOGO">', 99)
    expect(out).toBe('<img src="/api/messages/99/attachments/LOGO">')
  })

  it('5. leaves http URLs alone', () => {
    const html = '<img src="https://example.com/foo.png">'
    expect(rewriteCidUris(html, 1)).toBe(html)
  })

  it('6. leaves data: URIs alone', () => {
    const html = '<img src="data:image/png;base64,AAA">'
    expect(rewriteCidUris(html, 1)).toBe(html)
  })

  it('7. handles multiple cid: in one body', () => {
    const html = '<img src="cid:a"><img src="cid:b">'
    const out = rewriteCidUris(html, 5)
    expect(out).toBe(
      '<img src="/api/messages/5/attachments/a"><img src="/api/messages/5/attachments/b">'
    )
  })

  it('8. URL-encodes safe-but-special characters in cid', () => {
    // @ is common in Content-IDs (RFC 2392 allows local@host syntax).
    const out = rewriteCidUris('<img src="cid:abc@host">', 1)
    expect(out).toContain('abc%40host')
  })

  it('9. empty input returns ""', () => {
    expect(rewriteCidUris('', 1)).toBe('')
  })

  it('10. null/undefined input returns ""', () => {
    expect(rewriteCidUris(null, 1)).toBe('')
    expect(rewriteCidUris(undefined, 1)).toBe('')
  })

  it('11. non-string input returns ""', () => {
    expect(rewriteCidUris(123, 1)).toBe('')
    expect(rewriteCidUris({}, 1)).toBe('')
  })

  it('12. preserves surrounding HTML structure', () => {
    const html = '<p>Hello <img src="cid:logo"> world!</p>'
    const out = rewriteCidUris(html, 99)
    expect(out).toBe('<p>Hello <img src="/api/messages/99/attachments/logo"> world!</p>')
  })

  it('13. handles whitespace around equals sign (rare but valid)', () => {
    const out = rewriteCidUris('<img src ="cid:x">', 1)
    expect(out).toContain('/api/messages/1/attachments/x')
  })
})

describe('rewriteMessageCids', () => {
  it('14. returns input unchanged for null/non-object', () => {
    expect(rewriteMessageCids(null)).toBe(null)
    expect(rewriteMessageCids(undefined)).toBe(undefined)
    expect(rewriteMessageCids('string')).toBe('string')
  })

  it('15. returns input unchanged when body_html is empty', () => {
    const m = { id: 1, body_html: '', body_text: 'plain' }
    const out = rewriteMessageCids(m)
    expect(out.body_html).toBe('')
    expect(out.body_text).toBe('plain')
  })

  it('16. rewrites body_html when present, leaves body_text alone', () => {
    const m = { id: 7, body_html: '<img src="cid:logo">', body_text: 'plain' }
    const out = rewriteMessageCids(m)
    expect(out.body_html).toBe('<img src="/api/messages/7/attachments/logo">')
    expect(out.body_text).toBe('plain')
  })

  it('17. does NOT mutate input (pure function)', () => {
    const m = { id: 7, body_html: '<img src="cid:logo">' }
    const original = m.body_html
    rewriteMessageCids(m)
    expect(m.body_html).toBe(original)
  })
})
