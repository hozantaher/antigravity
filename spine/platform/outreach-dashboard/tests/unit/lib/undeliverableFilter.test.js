// Unit — undeliverableFilter.js SQL-predicate builders + their safety invariants.
//
// The module is the single source of truth for the "undeliverable / bounce
// notification" signature that keeps NDRs out of the Odpovědi queue. These
// tests lock the two invariants that make inlining the patterns into SQL safe
// and correct:
//   1. injection-safety — the literal patterns carry NO single quote, so they
//      cannot break out of the surrounding '...' SQL string literal.
//   2. false-positive guard — a "noreply" sender is NOT part of the signature
//      (reply_inbox id 381 info+noreply@… "Re: Dotaz" is a real human reply).
//
// feedback_extreme_testing — risk-proportional: pure string builders, the real
// row-level behaviour is proven by the contract test (SQL wiring) + the PROD
// pilot (0 undeliverable rows actually returned).

import { describe, it, expect } from 'vitest'
import {
  UNDELIVERABLE_FROM_RX,
  UNDELIVERABLE_SUBJECT_RX,
  isUndeliverableSql,
  notUndeliverableSql,
} from '../../../src/lib/undeliverableFilter.js'

describe('undeliverableFilter — pattern invariants', () => {
  it('patterns contain no single quote (SQL-literal injection-safe)', () => {
    expect(UNDELIVERABLE_FROM_RX).not.toContain("'")
    expect(UNDELIVERABLE_SUBJECT_RX).not.toContain("'")
  })

  it('sender pattern matches canonical bounce senders', () => {
    expect(UNDELIVERABLE_FROM_RX).toContain('mailer-daemon')
    expect(UNDELIVERABLE_FROM_RX).toContain('postmaster')
  })

  it('sender pattern deliberately EXCLUDES noreply (id 381 false-positive guard)', () => {
    expect(UNDELIVERABLE_FROM_RX).not.toMatch(/no-?reply/i)
  })

  it('subject pattern covers Czech + English NDR wording', () => {
    expect(UNDELIVERABLE_SUBJECT_RX).toContain('nedoručiteln')
    expect(UNDELIVERABLE_SUBJECT_RX).toContain('undelivered')
    expect(UNDELIVERABLE_SUBJECT_RX).toContain('delivery status notification')
  })
})

describe('undeliverableFilter — SQL builders', () => {
  it('isUndeliverableSql wraps both columns in COALESCE and ORs them with ~*', () => {
    const sql = isUndeliverableSql('r.from_email', 'r.subject')
    expect(sql).toBe(
      `(COALESCE(r.from_email,'') ~* '${UNDELIVERABLE_FROM_RX}' OR COALESCE(r.subject,'') ~* '${UNDELIVERABLE_SUBJECT_RX}')`,
    )
  })

  it('honours caller-supplied column names (reply_inbox vs unmatched arm)', () => {
    const sql = isUndeliverableSql('u.from_address', 'u.subject')
    expect(sql).toContain("COALESCE(u.from_address,'')")
    expect(sql).toContain("COALESCE(u.subject,'')")
    expect(sql).not.toContain('r.from_email')
  })

  it('notUndeliverableSql is exactly NOT + isUndeliverableSql', () => {
    const cols = ['x.from_email', 'x.subject']
    expect(notUndeliverableSql(...cols)).toBe(`NOT ${isUndeliverableSql(...cols)}`)
  })
})
