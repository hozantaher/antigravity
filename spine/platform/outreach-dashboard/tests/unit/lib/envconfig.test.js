// MVP-4 — BFF envconfig boot validation tests.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mustHaveEnv, validateEnvSchema, validators } from '../../../src/lib/envconfig.js'

describe('mustHaveEnv', () => {
  let origEnv
  beforeEach(() => { origEnv = { ...process.env } })
  afterEach(() => { process.env = origEnv })

  it('T-1: returns parsed values when all keys present', () => {
    process.env.MV4_FOO = 'bar'
    process.env.MV4_BAZ = 'qux'
    const out = mustHaveEnv(['MV4_FOO', 'MV4_BAZ'], { exitOnFail: false })
    expect(out).toEqual({ MV4_FOO: 'bar', MV4_BAZ: 'qux' })
  })

  it('T-2: throws when a required key is missing (exitOnFail=false)', () => {
    delete process.env.MV4_MISSING
    expect(() => mustHaveEnv(['MV4_MISSING'], { exitOnFail: false })).toThrow(/MV4_MISSING/)
  })

  it('T-3: treats empty string as missing', () => {
    process.env.MV4_EMPTY = ''
    expect(() => mustHaveEnv(['MV4_EMPTY'], { exitOnFail: false })).toThrow(/MV4_EMPTY/)
  })

  it('T-4: treats whitespace-only as missing', () => {
    process.env.MV4_WS = '   '
    expect(() => mustHaveEnv(['MV4_WS'], { exitOnFail: false })).toThrow(/MV4_WS/)
  })

  it('T-5: lists every missing key in error message', () => {
    delete process.env.MV4_A
    delete process.env.MV4_B
    process.env.MV4_C = 'present'
    try {
      mustHaveEnv(['MV4_A', 'MV4_B', 'MV4_C'], { exitOnFail: false })
      expect.fail('should have thrown')
    } catch (e) {
      expect(e.message).toMatch(/MV4_A/)
      expect(e.message).toMatch(/MV4_B/)
      expect(e.message).not.toMatch(/MV4_C/)
    }
  })

  it('T-6: exitOnFail=true calls process.exit(2)', () => {
    delete process.env.MV4_NOPE
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('__exit__') })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(() => mustHaveEnv(['MV4_NOPE'])).toThrow('__exit__')
    expect(exitSpy).toHaveBeenCalledWith(2)
    exitSpy.mockRestore(); errSpy.mockRestore()
  })
})

describe('validateEnvSchema', () => {
  let origEnv
  beforeEach(() => { origEnv = { ...process.env } })
  afterEach(() => { process.env = origEnv })

  it('T-7: applies default for missing optional keys', () => {
    delete process.env.MV4_OPT
    const out = validateEnvSchema(
      { MV4_OPT: { default: 'x' } },
      { exitOnFail: false },
    )
    expect(out.MV4_OPT).toBe('x')
  })

  it('T-8: required key without default fails', () => {
    delete process.env.MV4_REQ
    expect(() =>
      validateEnvSchema({ MV4_REQ: { required: true } }, { exitOnFail: false }),
    ).toThrow(/MV4_REQ/)
  })

  it('T-9: validator returning string flags violation', () => {
    process.env.MV4_PORT = 'abc'
    expect(() =>
      validateEnvSchema({ MV4_PORT: { validator: validators.port } }, { exitOnFail: false }),
    ).toThrow(/port/i)
  })

  it('T-10: validator passing returns the value', () => {
    process.env.MV4_PORT = '8080'
    const out = validateEnvSchema(
      { MV4_PORT: { validator: validators.port } },
      { exitOnFail: false },
    )
    expect(out.MV4_PORT).toBe('8080')
  })
})

describe('validators', () => {
  it('T-11: url accepts well-formed URLs', () => {
    expect(validators.url('https://example.com')).toBe(true)
    expect(validators.url('not a url')).not.toBe(true)
  })

  it('T-12: port accepts 1-65535', () => {
    expect(validators.port('1')).toBe(true)
    expect(validators.port('65535')).toBe(true)
    expect(validators.port('0')).not.toBe(true)
    expect(validators.port('70000')).not.toBe(true)
    expect(validators.port('abc')).not.toBe(true)
  })

  it('T-13: oneOf accepts only allowed values', () => {
    const v = validators.oneOf(['a', 'b'])
    expect(v('a')).toBe(true)
    expect(v('b')).toBe(true)
    expect(v('c')).not.toBe(true)
  })

  it('T-14: nonEmpty rejects whitespace-only', () => {
    expect(validators.nonEmpty('x')).toBe(true)
    expect(validators.nonEmpty('   ')).not.toBe(true)
    expect(validators.nonEmpty('')).not.toBe(true)
  })
})
