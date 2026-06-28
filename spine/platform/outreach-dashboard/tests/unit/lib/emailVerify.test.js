import { describe, it, expect } from 'vitest'
import {
  validateSyntax, isDisposable, roleCategory, isSpamtrap,
  classifyStatus, runPureChecks, statusLabel, statusColor,
  EMAIL_STATUS, STATUS_META,
} from '../../../src/lib/emailVerify.js'

describe('validateSyntax', () => {
  it('accepts typical b2b addresses', () => {
    expect(validateSyntax('jan.novak@firma.cz').ok).toBe(true)
    expect(validateSyntax('info+tag@example.co.uk').ok).toBe(true)
    expect(validateSyntax('user_name-42@sub.domain.com').ok).toBe(true)
  })
  it('lowercases domain, preserves local', () => {
    const r = validateSyntax('Jan@FIRMA.CZ')
    expect(r.ok).toBe(true)
    expect(r.domain).toBe('firma.cz')
    expect(r.local).toBe('Jan')
  })
  it('rejects empty / non-string', () => {
    expect(validateSyntax('').ok).toBe(false)
    expect(validateSyntax(null).ok).toBe(false)
    expect(validateSyntax(undefined).ok).toBe(false)
  })
  it('rejects missing @ or missing TLD', () => {
    expect(validateSyntax('no-at-sign.cz').ok).toBe(false)
    expect(validateSyntax('a@b').ok).toBe(false)      // no dot in domain
    expect(validateSyntax('a@b.c').ok).toBe(false)    // 1-char TLD
    expect(validateSyntax('@firma.cz').ok).toBe(false)
    expect(validateSyntax('local@').ok).toBe(false)
  })
  it('rejects consecutive / leading / trailing dots in local', () => {
    expect(validateSyntax('.a@firma.cz').ok).toBe(false)
    expect(validateSyntax('a.@firma.cz').ok).toBe(false)
    expect(validateSyntax('a..b@firma.cz').ok).toBe(false)
  })
  it('rejects invalid characters', () => {
    expect(validateSyntax('a b@firma.cz').ok).toBe(false)
    expect(validateSyntax('a"b@firma.cz').ok).toBe(false)
  })
  it('rejects over-length local or full email', () => {
    const long = 'a'.repeat(65) + '@firma.cz'
    expect(validateSyntax(long).ok).toBe(false)
    const huge = 'a'.repeat(260) + '@firma.cz'
    expect(validateSyntax(huge).ok).toBe(false)
  })
})

describe('isDisposable', () => {
  it('flags known disposable domains case-insensitively', () => {
    expect(isDisposable('mailinator.com')).toBe(true)
    expect(isDisposable('GUERRILLAMAIL.COM')).toBe(true)
    expect(isDisposable('10minutemail.com')).toBe(true)
  })
  it('returns false for normal domains', () => {
    expect(isDisposable('firma.cz')).toBe(false)
    expect(isDisposable('gmail.com')).toBe(false)
    expect(isDisposable('')).toBe(false)
    expect(isDisposable(null)).toBe(false)
  })
})

describe('roleCategory', () => {
  it('flags dangerous roles', () => {
    expect(roleCategory('abuse')).toBe('dangerous')
    expect(roleCategory('noreply')).toBe('dangerous')
    expect(roleCategory('postmaster')).toBe('dangerous')
  })
  it('flags risky roles', () => {
    expect(roleCategory('info')).toBe('risky')
    expect(roleCategory('sales')).toBe('risky')
    expect(roleCategory('kontakt')).toBe('risky')
    expect(roleCategory('podpora')).toBe('risky')
  })
  it('returns null for personal locals', () => {
    expect(roleCategory('jan.novak')).toBe(null)
    expect(roleCategory('petr')).toBe(null)
  })
  it('handles empty / null', () => {
    expect(roleCategory('')).toBe(null)
    expect(roleCategory(null)).toBe(null)
  })
})

describe('isSpamtrap', () => {
  it('detects known spamtrap domains', () => {
    expect(isSpamtrap('foo@spamhaus.org')).toBe(true)
    expect(isSpamtrap('bar@example.com')).toBe(true)
  })
  it('detects local-part patterns', () => {
    expect(isSpamtrap('spamtrap@firma.cz')).toBe(true)
    expect(isSpamtrap('honeypot@firma.cz')).toBe(true)
    expect(isSpamtrap('trap-xyz@firma.cz')).toBe(true)
  })
  it('detects high-entropy random locals', () => {
    // 12+ chars, <15% vowels
    expect(isSpamtrap('xkjvtbcwnrps@firma.cz')).toBe(true)
  })
  it('does not flag normal emails', () => {
    expect(isSpamtrap('jan.novak@firma.cz')).toBe(false)
    expect(isSpamtrap('info@example-business.cz')).toBe(false)
  })
})

describe('classifyStatus', () => {
  const base = {
    syntax_valid: true, mx_exists: true, smtp_valid: true,
    is_catch_all: false, is_disposable: false, is_spamtrap: false, is_role: null,
  }
  it('returns valid when all green', () => {
    expect(classifyStatus(base).status).toBe(EMAIL_STATUS.VALID)
  })
  it('invalid on bad syntax', () => {
    expect(classifyStatus({ ...base, syntax_valid: false }).status).toBe(EMAIL_STATUS.INVALID)
  })
  it('spamtrap short-circuits before other checks', () => {
    expect(classifyStatus({ ...base, is_spamtrap: true }).status).toBe(EMAIL_STATUS.SPAMTRAP)
  })
  it('disposable → invalid', () => {
    expect(classifyStatus({ ...base, is_disposable: true }).status).toBe(EMAIL_STATUS.INVALID)
  })
  it('no MX → invalid', () => {
    expect(classifyStatus({ ...base, mx_exists: false }).status).toBe(EMAIL_STATUS.INVALID)
  })
  it('dangerous role → invalid', () => {
    expect(classifyStatus({ ...base, is_role: 'dangerous' }).status).toBe(EMAIL_STATUS.INVALID)
  })
  it('SMTP reject → invalid', () => {
    expect(classifyStatus({ ...base, smtp_valid: false }).status).toBe(EMAIL_STATUS.INVALID)
  })
  it('catch-all domain → catch_all', () => {
    expect(classifyStatus({ ...base, is_catch_all: true }).status).toBe(EMAIL_STATUS.CATCH_ALL)
  })
  it('risky role → role_only', () => {
    expect(classifyStatus({ ...base, is_role: 'risky' }).status).toBe(EMAIL_STATUS.ROLE_ONLY)
  })
  it('MX exists but no SMTP probe → risky', () => {
    expect(classifyStatus({ ...base, smtp_valid: null }).status).toBe(EMAIL_STATUS.RISKY)
  })
})

describe('runPureChecks', () => {
  it('returns syntax_valid=false for bad email', () => {
    const r = runPureChecks('bad-email')
    expect(r.syntax_valid).toBe(false)
    expect(r.is_disposable).toBe(false)
  })
  it('runs all pure checks for good syntax', () => {
    const r = runPureChecks('info@firma.cz')
    expect(r.syntax_valid).toBe(true)
    expect(r.domain).toBe('firma.cz')
    expect(r.is_role).toBe('risky')
    expect(r.is_disposable).toBe(false)
    expect(r.mx_exists).toBe(null) // pure only — no network
    expect(r.smtp_valid).toBe(null)
  })
  it('flags disposable domain', () => {
    expect(runPureChecks('x@mailinator.com').is_disposable).toBe(true)
  })
})

describe('STATUS_META + label helpers', () => {
  it('every EMAIL_STATUS value has meta', () => {
    for (const v of Object.values(EMAIL_STATUS)) {
      expect(STATUS_META[v]).toBeDefined()
      expect(typeof STATUS_META[v].label).toBe('string')
      expect(typeof STATUS_META[v].color).toBe('string')
    }
  })
  it('statusLabel falls back to value', () => {
    expect(statusLabel('valid')).toBe('Platný')
    expect(statusLabel('mystery')).toBe('mystery')
    expect(statusLabel(null)).toBe('—')
  })
  it('statusColor falls back to muted', () => {
    expect(statusColor('unknown')).toBe('var(--muted)')
  })
})
