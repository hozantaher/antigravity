import { describe, expect, it } from 'vitest'
import { resolveRequestLocale } from '~/server/utils/requestLocale'
import { makeEvent } from '../setup/server'

const resolve = (acceptLanguage?: string, requested?: string) =>
  resolveRequestLocale(
    makeEvent({ headers: acceptLanguage ? { 'accept-language': acceptLanguage } : {} }) as never,
    requested,
  )

describe('resolveRequestLocale', () => {
  it('prefers a supported explicit locale (case-insensitive)', () => {
    expect(resolve(undefined, 'en')).toBe('en')
    expect(resolve('de-DE', 'CZ')).toBe('cz')
  })

  it('falls through an unsupported explicit locale to Accept-Language', () => {
    expect(resolve('de-DE', 'xx')).toBe('de')
  })

  it('maps Accept-Language two-letter aliases (cs→cz, uk→ua, sr→rs)', () => {
    expect(resolve('cs-CZ,cs;q=0.9')).toBe('cz')
    expect(resolve('uk')).toBe('ua')
    expect(resolve('sr-Latn')).toBe('rs')
  })

  it('defaults to cz when nothing matches', () => {
    expect(resolve()).toBe('cz')
    expect(resolve('sk-SK')).toBe('cz')
  })
})
