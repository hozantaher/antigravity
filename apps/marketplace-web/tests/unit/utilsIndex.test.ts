import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apiErrorMessage,
  fetchItemOrNull,
  formatAmount,
  formatDate,
  formatDepositAmount,
  formatPrice,
  getDeeplLocale,
  getGdprLink,
  getTermsLink,
  isFormValid,
  parseUserIdentifier,
  remainingTime,
} from '~/utils'

const norm = (s: string) => s.replace(/\s/g, ' ')

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('formatDate', () => {
  it.each([
    ['2025-01-03', 'DD.MM.yyyy', '03.01.2025'],
    ['2025-01-03', 'yyyy-MM-DD', '2025-01-03'],
    ['2025-12-09', undefined, '09.12.2025'],
  ])('parses a date-only string %s as local midnight', (input, fmt, expected) => {
    expect(formatDate(input, fmt)).toBe(expected)
  })

  it('formats a non-date-only string via Date constructor', () => {
    expect(formatDate('2025-01-03T14:05', 'YYYY-MM-DD HH:mm')).toBe('2025-01-03 14:05')
  })

  it('formats a local Date with all time tokens', () => {
    const d = new Date(2025, 0, 3, 14, 5, 9)
    expect(formatDate(d, 'DD.MM.yyyy HH:mm:ss')).toBe('03.01.2025 14:05:09')
    expect(formatDate(d.getTime(), 'HH:mm:ss')).toBe('14:05:09')
  })
})

describe('isFormValid', () => {
  it('returns true when every field validates', () => {
    const validate = vi.fn()
    const a = { value: { validate, isValid: true } }
    const b = { value: { validate, isValid: true } }
    expect(isFormValid([a, b] as never)).toBe(true)
    expect(validate).toHaveBeenCalledTimes(2)
  })

  it('returns false when any field is invalid', () => {
    const a = { value: { validate: vi.fn(), isValid: true } }
    const b = { value: { validate: vi.fn(), isValid: false } }
    expect(isFormValid([a, b] as never)).toBe(false)
  })

  it('treats a null ref value as invalid (optional-chain branch)', () => {
    const a = { value: null }
    expect(isFormValid([a] as never)).toBe(false)
  })
})

describe('apiErrorMessage', () => {
  it.each([
    [{ data: { statusMessage: 'Nested' } }, 'Nested'],
    [{ statusMessage: 'Top' }, 'Top'],
    [{}, 'Something went wrong'],
    [null, 'Something went wrong'],
    [undefined, 'Something went wrong'],
  ])('extracts the best message from %o', (err, expected) => {
    expect(apiErrorMessage(err)).toBe(expected)
  })

  it('honours a custom fallback', () => {
    expect(apiErrorMessage({}, 'Custom')).toBe('Custom')
  })
})

describe('fetchItemOrNull', () => {
  it('returns the fetched item on success and encodes the id', async () => {
    const item = { id: 'a/b' }
    const fetchFn = vi.fn().mockResolvedValue(item)
    vi.stubGlobal('$fetch', fetchFn)
    expect(await fetchItemOrNull('a/b')).toBe(item)
    expect(fetchFn).toHaveBeenCalledWith('/api/item/a%2Fb')
  })

  it('swallows failures and returns null', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(new Error('boom')))
    expect(await fetchItemOrNull('missing')).toBeNull()
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

describe('formatDepositAmount', () => {
  it('formats with the ISO currency, no decimals', () => {
    expect(norm(formatDepositAmount(10000, 'CZK'))).toContain('10 000')
    expect(norm(formatDepositAmount(10000, 'CZK'))).toContain('Kč')
    expect(formatDepositAmount(500, 'EUR')).toContain('500')
  })
})

describe('formatPrice', () => {
  it('prefixes the symbol when symbolBefore', () => {
    expect(formatPrice({ amount: 1000, currency: { symbol: '€', symbolBefore: true } } as never)).toBe('€1,000')
  })
  it('suffixes the symbol otherwise', () => {
    expect(formatPrice({ amount: 1000, currency: { symbol: 'Kč', symbolBefore: false } } as never)).toBe('1,000 Kč')
  })
  it('falls back to empty symbol when currency is missing', () => {
    expect(formatPrice({ amount: 1000 } as never)).toBe('1,000 ')
  })
  it('returns --- for undefined', () => {
    expect(formatPrice(undefined)).toBe('---')
  })
})

describe('remainingTime', () => {
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

  it('accepts a Date instance', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2025, 0, 1, 0, 0, 0))
    const target = new Date(Date.now() + 5 * 1000)
    expect(remainingTime(target)).toBe('00:00:00:05')
  })

  it('returns empty string for falsy input', () => {
    expect(remainingTime(0)).toBe('')
  })
})

describe('link + locale helpers', () => {
  it('parseUserIdentifier joins first and last three chars', () => {
    expect(parseUserIdentifier('abcdef1234')).toBe('abc234')
  })

  it('parseUserIdentifier handles undefined input', () => {
    expect(parseUserIdentifier()).toBe('undefinedundefined')
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
