/**
 * TDD: anonymityAnalyzer — testy pro S15 anonymity probe (≥12 test cases).
 * Spustit: cd features/platform/outreach-dashboard && pnpm test src/lib/anonymityAnalyzer
 */
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { analyzeAnonymity } from '../../../src/lib/anonymityAnalyzer'

// ── Čisté headers (relay only) → score=100 ────────────────────────────────────
describe('analyzeAnonymity — čisté headers', () => {
  it('relay-only headers → score=100, žádné leaky', () => {
    const headers = [
      'Received: from relay.example.com (relay.example.com [203.0.113.42])',
      '        by mx.seznam.cz with ESMTP; Thu, 24 Apr 2026 10:00:00 +0200',
      'Message-ID: <20260424100000.AA001@relay.example.com>',
      'Date: Thu, 24 Apr 2026 10:00:00 +0200',
      'From: sender@firma.cz',
      'To: recipient@firma2.cz',
      'Subject: Test email',
    ].join('\n')

    const result = analyzeAnonymity(headers)
    expect(result.score).toBe(100)
    expect(result.leaks).toHaveLength(0)
  })

  it('prázdné headers (empty string) → score=100', () => {
    const result = analyzeAnonymity('')
    expect(result.score).toBe(100)
    expect(result.leaks).toHaveLength(0)
  })

  it('pouze Date header → score=100 (nic k leakování)', () => {
    const result = analyzeAnonymity('Date: Thu, 24 Apr 2026 10:00:00 +0000')
    expect(result.score).toBe(100)
    expect(result.leaks).toHaveLength(0)
  })
})

// ── Received chain s private IP ───────────────────────────────────────────────
describe('analyzeAnonymity — private IP v Received', () => {
  it('Received s 192.168.x.x → received_chain_clean=false', () => {
    const headers = 'Received: from mail.local (192.168.1.100) by mx.example.com'
    const result = analyzeAnonymity(headers)
    expect(result.checks.received_chain_clean).toBe(false)
    expect(result.leaks).toContain('received_chain_clean')
    expect(result.score).toBeLessThan(100)
  })

  it('Received s 10.x.x.x → received_chain_clean=false', () => {
    const headers = 'Received: from 10.0.0.5 by relay.example.com'
    const result = analyzeAnonymity(headers)
    expect(result.checks.received_chain_clean).toBe(false)
    expect(result.leaks).toContain('received_chain_clean')
  })

  it('Received s 172.16.x.x → received_chain_clean=false', () => {
    const headers = 'Received: from corp-mail (172.16.0.10) by relay.example.com'
    const result = analyzeAnonymity(headers)
    expect(result.checks.received_chain_clean).toBe(false)
  })

  it('Received s veřejnou IP → received_chain_clean=true', () => {
    const headers = 'Received: from relay.example.com (203.0.113.42) by mx.example.com'
    const result = analyzeAnonymity(headers)
    expect(result.checks.received_chain_clean).toBe(true)
  })
})

// ── X-Originating-IP ─────────────────────────────────────────────────────────
describe('analyzeAnonymity — X-Originating-IP', () => {
  it('X-Originating-IP přítomen → no_originating_ip=false', () => {
    const headers = 'X-Originating-IP: 84.42.100.5\nFrom: sender@example.com'
    const result = analyzeAnonymity(headers)
    expect(result.checks.no_originating_ip).toBe(false)
    expect(result.leaks).toContain('no_originating_ip')
  })

  it('X-Originating-IP chybí → no_originating_ip=true', () => {
    const headers = 'From: sender@example.com\nTo: recipient@example.com'
    const result = analyzeAnonymity(headers)
    expect(result.checks.no_originating_ip).toBe(true)
  })
})

// ── Message-ID s IP adresou ───────────────────────────────────────────────────
describe('analyzeAnonymity — Message-ID', () => {
  it('Message-ID s IP adresou → message_id_clean=false', () => {
    const headers = 'Message-ID: <unique123@84.42.100.5>'
    const result = analyzeAnonymity(headers)
    expect(result.checks.message_id_clean).toBe(false)
    expect(result.leaks).toContain('message_id_clean')
  })

  it('Message-ID s hostname (bez IP) → message_id_clean=true', () => {
    const headers = 'Message-ID: <20260424.AA001@relay.example.com>'
    const result = analyzeAnonymity(headers)
    expect(result.checks.message_id_clean).toBe(true)
  })

  it('chybějící Message-ID → message_id_clean=true (žádný leak)', () => {
    const headers = 'From: sender@example.com'
    const result = analyzeAnonymity(headers)
    expect(result.checks.message_id_clean).toBe(true)
  })
})

// ── X-Mailer / User-Agent ─────────────────────────────────────────────────────
describe('analyzeAnonymity — X-Mailer / User-Agent', () => {
  it('X-Mailer přítomen → no_user_agent_leak=false', () => {
    const headers = 'X-Mailer: Thunderbird 115.0\nFrom: sender@example.com'
    const result = analyzeAnonymity(headers)
    expect(result.checks.no_user_agent_leak).toBe(false)
    expect(result.leaks).toContain('no_user_agent_leak')
  })

  it('User-Agent přítomen → no_user_agent_leak=false', () => {
    const headers = 'User-Agent: Mozilla/5.0 (compatible; Thunderbird)\nFrom: sender@example.com'
    const result = analyzeAnonymity(headers)
    expect(result.checks.no_user_agent_leak).toBe(false)
    expect(result.leaks).toContain('no_user_agent_leak')
  })

  it('bez X-Mailer a User-Agent → no_user_agent_leak=true', () => {
    const headers = 'From: sender@example.com\nDate: Thu, 24 Apr 2026 10:00:00 +0200'
    const result = analyzeAnonymity(headers)
    expect(result.checks.no_user_agent_leak).toBe(true)
  })
})

// ── localhost v Received ──────────────────────────────────────────────────────
describe('analyzeAnonymity — localhost v Received', () => {
  it('localhost v Received → no_local_hostname=false', () => {
    const headers = 'Received: from localhost by relay.example.com'
    const result = analyzeAnonymity(headers)
    expect(result.checks.no_local_hostname).toBe(false)
    expect(result.leaks).toContain('no_local_hostname')
  })

  it('127.0.0.1 v Received → no_local_hostname=false', () => {
    const headers = 'Received: from 127.0.0.1 by relay.example.com'
    const result = analyzeAnonymity(headers)
    expect(result.checks.no_local_hostname).toBe(false)
  })

  it('.local hostname v Received → no_local_hostname=false', () => {
    const headers = 'Received: from mailbox.local by relay.example.com'
    const result = analyzeAnonymity(headers)
    expect(result.checks.no_local_hostname).toBe(false)
  })

  it('čistý hostname v Received → no_local_hostname=true', () => {
    const headers = 'Received: from mail.firma.cz (mail.firma.cz [203.0.113.10]) by mx.seznam.cz'
    const result = analyzeAnonymity(headers)
    expect(result.checks.no_local_hostname).toBe(true)
  })
})

// ── Všechny leaky → score=0 ───────────────────────────────────────────────────
describe('analyzeAnonymity — extrémní případy', () => {
  it('všechny leaky najednou → score≤20', () => {
    const headers = [
      'Received: from 192.168.1.100 by relay.example.com',
      'Received: from localhost by mx.example.com',
      'X-Originating-IP: 10.0.0.1',
      'Message-ID: <test@192.168.1.100>',
      'X-Mailer: Thunderbird 115.0',
    ].join('\n')

    const result = analyzeAnonymity(headers)
    // received_chain_clean, no_originating_ip, message_id_clean, no_user_agent_leak, no_local_hostname — 5 fails z 6
    expect(result.score).toBeLessThanOrEqual(20)
    expect(result.leaks.length).toBeGreaterThanOrEqual(4)
  })

  it('smíšené: 3 z 6 checks fail → score=50', () => {
    const headers = [
      // FAIL: private IP v Received
      'Received: from 192.168.1.100 by relay.example.com',
      // FAIL: X-Originating-IP
      'X-Originating-IP: 84.42.100.5',
      // FAIL: X-Mailer
      'X-Mailer: Thunderbird 115.0',
      // OK: čistý Message-ID (hostname, bez IP)
      'Message-ID: <abc@relay.example.com>',
      // OK: Date bez problémů
      'Date: Thu, 24 Apr 2026 10:00:00 +0200',
      // OK: Received bez localhost (jiný Received řádek je problematický, ale jen jeden check)
      // no_local_hostname zkontroluje localhost — ten tu není
    ].join('\n')

    const result = analyzeAnonymity(headers)
    // 3 fail (received_chain_clean, no_originating_ip, no_user_agent_leak)
    // 3 pass (message_id_clean, date_timezone_neutral, no_local_hostname)
    expect(result.score).toBe(50)
    expect(result.leaks).toHaveLength(3)
  })

  it('non-string vstup (null) → score=100, žádné leaky', () => {
    const result = analyzeAnonymity(null)
    expect(result.score).toBe(100)
    expect(result.leaks).toHaveLength(0)
  })

  it('non-string vstup (undefined) → score=100, žádné leaky', () => {
    const result = analyzeAnonymity(undefined)
    expect(result.score).toBe(100)
    expect(result.leaks).toHaveLength(0)
  })

  it('non-string vstup (object) → score=100', () => {
    const result = analyzeAnonymity({ headers: 'something' })
    expect(result.score).toBe(100)
  })
})

// ── Reálné seznam.cz headers sample ──────────────────────────────────────────
describe('analyzeAnonymity — reálné seznam.cz headers', () => {
  it('seznam.cz relay headers — bez private IP → score≥83', () => {
    // Simulace headerů jak je vrací seznam.cz MX po přijetí emailu
    const headers = [
      'Received: from smtp.seznam.cz (smtp.seznam.cz [77.75.77.44])',
      '        by mx2.seznam.cz with ESMTPS id x1234',
      '        for <recipient@seznam.cz>; Thu, 24 Apr 2026 10:00:00 +0200',
      'Received: from relay.example.com (relay.example.com [203.0.113.42])',
      '        by smtp.seznam.cz with ESMTP; Thu, 24 Apr 2026 09:59:58 +0200',
      'Message-ID: <20260424095958.AB001@relay.example.com>',
      'Date: Thu, 24 Apr 2026 09:59:58 +0200',
      'From: probe@firma.cz',
      'To: probe2@seznam.cz',
      'Subject: Anonymity Probe',
    ].join('\n')

    const result = analyzeAnonymity(headers)
    // Všechny checks by měly projít (žádná private IP, žádný X-Originating-IP, atd.)
    expect(result.score).toBeGreaterThanOrEqual(83)
    expect(result.checks.received_chain_clean).toBe(true)
    expect(result.checks.no_originating_ip).toBe(true)
    expect(result.checks.no_local_hostname).toBe(true)
  })
})

// ── Výsledková struktura ──────────────────────────────────────────────────────
describe('analyzeAnonymity — výsledková struktura', () => {
  it('vrací score, leaks, checks vždy', () => {
    const result = analyzeAnonymity('From: test@example.com')
    expect(result).toHaveProperty('score')
    expect(result).toHaveProperty('leaks')
    expect(result).toHaveProperty('checks')
    expect(typeof result.score).toBe('number')
    expect(Array.isArray(result.leaks)).toBe(true)
    expect(typeof result.checks).toBe('object')
  })

  it('score je vždy v rozsahu 0-100', () => {
    const testCases = [
      '',
      'X-Originating-IP: 1.2.3.4',
      'Received: from 192.168.1.1 by mx.example.com',
      'Message-ID: <test@10.0.0.1>',
      'X-Mailer: SomeClient\nUser-Agent: SomeAgent',
    ]
    for (const headers of testCases) {
      const result = analyzeAnonymity(headers)
      expect(result.score).toBeGreaterThanOrEqual(0)
      expect(result.score).toBeLessThanOrEqual(100)
    }
  })

  it('leaks pole obsahuje pouze string klíče z checks', () => {
    const headers = 'X-Originating-IP: 1.2.3.4\nX-Mailer: Test'
    const result = analyzeAnonymity(headers)
    const checkKeys = Object.keys(result.checks)
    for (const leak of result.leaks) {
      expect(checkKeys).toContain(leak)
    }
  })
})

// ── MONKEY: property-based test ───────────────────────────────────────────────
describe('analyzeAnonymity — MONKEY / property-based', () => {
  it('náhodné header strings → žádný crash, score vždy 0-100', () => {
    fc.assert(
      fc.property(
        fc.string(),
        (input) => {
          const result = analyzeAnonymity(input)
          expect(result.score).toBeGreaterThanOrEqual(0)
          expect(result.score).toBeLessThanOrEqual(100)
          expect(Array.isArray(result.leaks)).toBe(true)
          expect(typeof result.checks).toBe('object')
        }
      ),
      { numRuns: 200 }
    )
  })

  it('non-string vstupy různých typů → vždy score=100', () => {
    const nonStrings = [null, undefined, 42, true, false, [], {}, Symbol('x'), () => {}]
    for (const input of nonStrings) {
      const result = analyzeAnonymity(input)
      expect(result.score).toBe(100)
      expect(result.leaks).toHaveLength(0)
    }
  })
})
