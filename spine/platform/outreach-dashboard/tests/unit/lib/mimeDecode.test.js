import { describe, it, expect } from 'vitest'
import { decodeMimeWords } from '../../../src/lib/mimeDecode.js'

describe('decodeMimeWords', () => {
  it('decodes Q (quoted-printable) Czech subject', () => {
    expect(decodeMimeWords('=?UTF-8?Q?Nep=C5=99=C3=ADtomnost_Re:_Dotaz?=')).toBe('Nepřítomnost Re: Dotaz')
  })
  it('decodes B (base64)', () => {
    expect(decodeMimeWords('=?UTF-8?B?UsOhbm8=?=')).toBe('Ráno')
  })
  it('passes plain ASCII through unchanged', () => {
    expect(decodeMimeWords('RE: Dotaz')).toBe('RE: Dotaz')
  })
  it('handles null/undefined/non-string', () => {
    expect(decodeMimeWords(null)).toBeNull()
    expect(decodeMimeWords(undefined)).toBeUndefined()
  })
  it('lowercase q token works', () => {
    expect(decodeMimeWords('=?utf-8?q?Popt=C3=A1vka?=')).toBe('Poptávka')
  })
})
