import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apiErrorMessage,
  formatAmount,
  formatDate,
  formatDepositAmount,
  formatPrice,
  getDeeplLocale,
  getGdprLink,
  getTermsLink,
  parseUserIdentifier,
  remainingTime,
} from '~/utils'
import { isValidVin } from '~/features/supply/vehicle-vin/logic/vin'

const norm = (s: string) => s.replace(/\s/g, ' ')

describe('formatDate', () => {
  it.each([
    ['2025-01-03', 'DD.MM.yyyy', '03.01.2025'],
    ['2025-01-03', 'yyyy-MM-DD', '2025-01-03'],
    ['2025-12-09', undefined, '09.12.2025'],
  ])('formats date-only string %s as local midnight', (input, fmt, expected) => {
    expect(formatDate(input, fmt)).toBe(expected)
  })

  it('formats a local Date with time tokens', () => {
    const d = new Date(2025, 0, 3, 14, 5, 9)
    expect(formatDate(d, 'DD.MM.yyyy HH:mm')).toBe('03.01.2025 14:05')
    expect(formatDate(d.getTime(), 'HH:mm:ss')).toBe('14:05:09')
  })
})

describe('formatAmount', () => {
  it.each([
    [1234.5, '1,234.5'],
    [1000000, '1,000,000'],
    [99.999, '100'],
  ])('groups %d as en-US', (input, expected) => {
    expect(formatAmount(input)).toBe(expected)
  })

  it.each([[undefined], [0]])('returns --- for falsy amount %s', input => {
    expect(formatAmount(input)).toBe('---')
  })
})

describe('formatPrice', () => {
  it('prefixes the symbol when symbolBefore', () => {
    expect(formatPrice({ amount: 1000, currency: { symbol: '€', symbolBefore: true } } as never)).toBe('€1,000')
  })
  it('suffixes the symbol otherwise', () => {
    expect(formatPrice({ amount: 1000, currency: { symbol: 'Kč', symbolBefore: false } } as never)).toBe('1,000 Kč')
  })
  it('returns --- for undefined', () => {
    expect(formatPrice(undefined)).toBe('---')
  })
})

describe('formatDepositAmount', () => {
  it('formats with the ISO currency, no decimals', () => {
    expect(norm(formatDepositAmount(10000, 'CZK'))).toContain('10 000')
    expect(norm(formatDepositAmount(10000, 'CZK'))).toContain('Kč')
    expect(formatDepositAmount(500, 'EUR')).toContain('500')
  })
})

describe('remainingTime', () => {
  afterEach(() => vi.useRealTimers())

  it('renders DD:HH:MM:SS until the target', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2025, 0, 1, 0, 0, 0))
    const target = Date.now() + (1 * 86400 + 2 * 3600 + 3 * 60 + 4) * 1000
    expect(remainingTime(target)).toBe('01:02:03:04')
  })

  it('clamps past targets to zeros', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2025, 0, 1))
    expect(remainingTime(Date.now() - 5000)).toBe('00:00:00:00')
  })

  it('returns empty string for falsy input', () => {
    expect(remainingTime(0)).toBe('')
  })
})

describe('apiErrorMessage', () => {
  it.each([
    [{ data: { statusMessage: 'Nested' } }, 'Nested'],
    [{ statusMessage: 'Top' }, 'Top'],
    [{}, 'Something went wrong'],
    [null, 'Something went wrong'],
  ])('extracts the best message from %o', (err, expected) => {
    expect(apiErrorMessage(err)).toBe(expected)
  })

  it('honours a custom fallback', () => {
    expect(apiErrorMessage({}, 'Custom')).toBe('Custom')
  })
})

describe('misc helpers', () => {
  it('parseUserIdentifier joins first and last three chars', () => {
    expect(parseUserIdentifier('abcdef1234')).toBe('abc234')
  })
  it.each([
    ['cz', 'CS'],
    ['ua', 'UK'],
    ['xx', undefined],
  ])('getDeeplLocale(%s)', (locale, expected) => {
    expect(getDeeplLocale(locale)).toBe(expected)
  })
  it('getTermsLink / getGdprLink switch on cz', () => {
    expect(getTermsLink('cz')).toBe('/terms/terms_cz.pdf')
    expect(getTermsLink('en')).toBe('/terms/terms_en.pdf')
    expect(getGdprLink('cz')).toBe('/terms/gdpr_cz.pdf')
    expect(getGdprLink('de')).toBe('/terms/gdpr_en.pdf')
  })
})

describe('isValidVin', () => {
  it.each([
    ['WBA12345678901234', true],
    ['  wba12345678901234  ', true],
    ['WBAI2345678901234', false], // contains I
    ['WBAO2345678901234', false], // contains O
    ['WBAQ2345678901234', false], // contains Q
    ['SHORT', false],
    ['', false],
  ])('isValidVin(%s) === %s', (vin, expected) => {
    expect(isValidVin(vin)).toBe(expected)
  })
})
