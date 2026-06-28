/**
 * htmlToText — minimal HTML→plain-text for the mining/signature path (#1579 H1.1).
 * The point is that mining works on HTML-only replies, so we assert the textual
 * content (phones, IČO, line structure) survives the conversion.
 */

import { describe, it, expect } from 'vitest'
import { htmlToText } from '../../../src/lib/htmlToText.js'
import { mineReplySignals } from '../../../src/lib/mineReplySignals.js'

describe('htmlToText', () => {
  it('strips tags and keeps the text', () => {
    expect(htmlToText('<p>Dobrý den</p>')).toBe('Dobrý den')
  })

  it('turns block tags and <br> into newlines (keeps signature structure)', () => {
    const t = htmlToText('Firma s.r.o.<br>IČO: 12345678<br>tel: 775040593')
    expect(t.split('\n')).toEqual(['Firma s.r.o.', 'IČO: 12345678', 'tel: 775040593'])
  })

  it('drops <style>/<script> bodies', () => {
    expect(htmlToText('<style>.x{color:red}</style><div>Ahoj</div>')).toBe('Ahoj')
  })

  it('decodes common + numeric entities', () => {
    expect(htmlToText('A&nbsp;B &amp; C &#39;x&#39;')).toBe('A B & C \'x\'')
  })

  it('returns empty string for null/empty/non-string', () => {
    expect(htmlToText(null)).toBe('')
    expect(htmlToText('')).toBe('')
    expect(htmlToText(123)).toBe('')
  })

  it('recovers minable signals from an HTML-only body', () => {
    const html = '<div>Mám zájem.</div><div>S pozdravem</div><div>tel: +420 775 040 593</div>'
    const { phones } = mineReplySignals(htmlToText(html))
    expect(phones[0].tel).toBe('+420775040593')
  })
})
