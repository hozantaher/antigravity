import { describe, expect, it } from 'vitest'
import { required, email, url, minLen, maxLen, pattern, number, range, compose, validate } from '../../../src/lib/validators'

describe('validators — required', () => {
  it('returns error for null', () => expect(required()(null)).toBe('Povinné pole'))
  it('returns error for undefined', () => expect(required()(undefined)).toBe('Povinné pole'))
  it('returns error for empty string', () => expect(required()('')).toBe('Povinné pole'))
  it('returns error for whitespace-only string', () => expect(required()('   ')).toBe('Povinné pole'))
  it('returns null for non-empty string', () => expect(required()('x')).toBeNull())
  it('returns null for zero (number is not empty)', () => expect(required()(0)).toBeNull())
  it('returns null for false', () => expect(required()(false)).toBeNull())
  it('accepts custom message', () => expect(required('Missing')('')).toBe('Missing'))
  it('returns null for array', () => expect(required()([])).toBeNull())
  it('returns null for object', () => expect(required()({})).toBeNull())
})

describe('validators — email', () => {
  it('passes plain address', () => expect(email()('a@b.co')).toBeNull())
  it('passes address with + alias', () => expect(email()('a+tag@b.co')).toBeNull())
  it('passes address with subdomain', () => expect(email()('a@mail.b.co')).toBeNull())
  it('fails missing @', () => expect(email()('ab.co')).toBe('Neplatný e-mail'))
  it('fails missing domain', () => expect(email()('a@')).toBe('Neplatný e-mail'))
  it('fails missing local', () => expect(email()('@b.co')).toBe('Neplatný e-mail'))
  it('fails missing tld', () => expect(email()('a@b')).toBe('Neplatný e-mail'))
  it('fails whitespace in local', () => expect(email()('a b@c.co')).toBe('Neplatný e-mail'))
  it('returns null for empty (optional)', () => expect(email()('')).toBeNull())
  it('returns null for undefined', () => expect(email()(undefined)).toBeNull())
  it('accepts custom message', () => expect(email('bad')('x')).toBe('bad'))
})

describe('validators — url', () => {
  it('passes https', () => expect(url()('https://a.co')).toBeNull())
  it('passes http', () => expect(url()('http://a.co')).toBeNull())
  it('passes with path', () => expect(url()('https://a.co/x')).toBeNull())
  it('fails garbage', () => expect(url()('not a url')).toBe('Neplatná URL'))
  it('fails missing scheme for bare word', () => expect(url()('a')).toBe('Neplatná URL'))
  it('returns null for empty (optional)', () => expect(url()('')).toBeNull())
  it('accepts custom message', () => expect(url('badu')('x')).toBe('badu'))
})

describe('validators — minLen/maxLen', () => {
  it('minLen fails short string', () => expect(minLen(3)('ab')).toBe('Minimálně 3 znaků'))
  it('minLen passes exact length', () => expect(minLen(3)('abc')).toBeNull())
  it('minLen passes over-length', () => expect(minLen(3)('abcd')).toBeNull())
  it('minLen returns null for empty (optional)', () => expect(minLen(3)('')).toBeNull())
  it('minLen custom msg', () => expect(minLen(5, 'short')('a')).toBe('short'))
  it('maxLen fails long string', () => expect(maxLen(3)('abcd')).toBe('Maximálně 3 znaků'))
  it('maxLen passes exact length', () => expect(maxLen(3)('abc')).toBeNull())
  it('maxLen custom msg', () => expect(maxLen(2, 'long')('abc')).toBe('long'))
})

describe('validators — pattern', () => {
  it('passes matching pattern', () => expect(pattern(/^[a-z]+$/)('abc')).toBeNull())
  it('fails non-matching', () => expect(pattern(/^[a-z]+$/)('Abc')).toBe('Neplatný formát'))
  it('returns null for empty', () => expect(pattern(/x/)('')).toBeNull())
  it('custom msg', () => expect(pattern(/x/, 'nope')('y')).toBe('nope'))
})

describe('validators — number', () => {
  it('passes integer', () => expect(number()(42)).toBeNull())
  it('passes numeric string', () => expect(number()('42')).toBeNull())
  it('passes float string', () => expect(number()('3.14')).toBeNull())
  it('fails non-numeric string', () => expect(number()('abc')).toBe('Musí být číslo'))
  it('returns null for empty', () => expect(number()('')).toBeNull())
  it('returns null for null', () => expect(number()(null)).toBeNull())
  it('fails Infinity string', () => expect(number()('Infinity')).toBe('Musí být číslo'))
})

describe('validators — range', () => {
  it('passes within range', () => expect(range(0, 10)(5)).toBeNull())
  it('passes min boundary', () => expect(range(0, 10)(0)).toBeNull())
  it('passes max boundary', () => expect(range(0, 10)(10)).toBeNull())
  it('fails below min', () => expect(range(0, 10)(-1)).toBe('Rozsah 0–10'))
  it('fails above max', () => expect(range(0, 10)(11)).toBe('Rozsah 0–10'))
  it('fails non-numeric', () => expect(range(0, 10)('abc')).toBe('Musí být číslo'))
  it('returns null for empty', () => expect(range(0, 10)('')).toBeNull())
  it('custom msg', () => expect(range(0, 10, 'rng')(99)).toBe('rng'))
})

describe('validators — compose', () => {
  it('returns first error encountered', () => {
    const v = compose(required(), minLen(3))
    expect(v('')).toBe('Povinné pole')
  })
  it('skips null errors to next validator', () => {
    const v = compose(required(), minLen(3))
    expect(v('ab')).toBe('Minimálně 3 znaků')
  })
  it('returns null when all pass', () => {
    const v = compose(required(), minLen(3))
    expect(v('abcd')).toBeNull()
  })
  it('tolerates nullish validator in chain', () => {
    const v = compose(null, required())
    expect(v('x')).toBeNull()
  })
})

describe('validators — validate', () => {
  it('returns valid:true when all fields pass', () => {
    const r = validate({ a: 'x' }, { a: required() })
    expect(r.valid).toBe(true)
    expect(r.errors).toEqual({})
  })
  it('returns errors keyed by field', () => {
    const r = validate({ a: '', b: 'x' }, { a: required(), b: minLen(3) })
    expect(r.valid).toBe(false)
    expect(r.errors.a).toBe('Povinné pole')
    expect(r.errors.b).toBe('Minimálně 3 znaků')
  })
  it('skips fields not in schema', () => {
    const r = validate({ a: 'x', extra: 'y' }, { a: required() })
    expect(r.errors.extra).toBeUndefined()
  })
  it('handles missing field with required', () => {
    const r = validate({}, { a: required() })
    expect(r.errors.a).toBe('Povinné pole')
  })
})
