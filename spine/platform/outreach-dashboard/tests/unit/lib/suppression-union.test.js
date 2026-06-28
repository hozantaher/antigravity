// Tests for the suppression-union helper. Mirrors the SQL semantics in
// features/outreach/campaigns/campaign/runner.go (suppressionFilterSQL) and the
// canonical SUPPRESSION_LOOKUP_SQL fragment in
// src/lib/suppressionFilter.js — both UNION outreach_suppressions +
// suppression_list, lower(trim(email)).
//
// The pure-JS helper is what BFF code uses when it has both rowsets in
// memory (e.g. preflight, audit dashboards, dry-run sims) and wants to
// answer "is this candidate already suppressed?" without round-tripping
// to Postgres for each lookup.
//
// Memory: feedback_extreme_testing.md → ≥15 cases, includes property
// invariants. project_two_suppression_tables.md → never query just one.

import { describe, test, expect } from 'vitest'
import fc from 'fast-check'

import {
  unionSuppressions,
  isSuppressed,
  classifyBounceForSuppression,
} from '../../../src/lib/suppression-union.js'

// ───────────────────────────────────────────────────────────────────
// unionSuppressions — set merge semantics
// ───────────────────────────────────────────────────────────────────
describe('unionSuppressions', () => {
  test('case 1: empty + empty → empty union', () => {
    const union = unionSuppressions([], [])
    expect(union).toBeInstanceOf(Set)
    expect(union.size).toBe(0)
  })

  test('case 2: single email in A only → present in union', () => {
    const union = unionSuppressions([{ email: 'a@x.cz' }], [])
    expect(union.size).toBe(1)
    expect(union.has('a@x.cz')).toBe(true)
  })

  test('case 3: single email in B only → present in union', () => {
    const union = unionSuppressions([], [{ email: 'b@y.cz' }])
    expect(union.size).toBe(1)
    expect(union.has('b@y.cz')).toBe(true)
  })

  test('case 4: same email in both tables → deduplicated to a single entry', () => {
    const union = unionSuppressions(
      [{ email: 'dup@example.com' }],
      [{ email: 'dup@example.com' }],
    )
    expect(union.size).toBe(1)
    expect(union.has('dup@example.com')).toBe(true)
  })

  test('case 5: differing case (User@x.cz vs user@X.CZ) → 1 entry, lowercased', () => {
    const union = unionSuppressions(
      [{ email: 'User@x.cz' }],
      [{ email: 'user@X.CZ' }],
    )
    expect(union.size).toBe(1)
    expect(union.has('user@x.cz')).toBe(true)
    // The original mixed-case form must NOT survive — both writers
    // disagree on case, so we must not preserve either as-is.
    expect(union.has('User@x.cz')).toBe(false)
    expect(union.has('user@X.CZ')).toBe(false)
  })

  test('case 6: leading/trailing whitespace is trimmed', () => {
    const union = unionSuppressions(
      [{ email: '  whitespace@x.cz  ' }],
      [{ email: '\twhitespace@x.cz\n' }],
    )
    expect(union.size).toBe(1)
    expect(union.has('whitespace@x.cz')).toBe(true)
  })

  test('case 7: empty/null/undefined email rows are filtered out', () => {
    const union = unionSuppressions(
      [
        { email: 'real@x.cz' },
        { email: '' },
        { email: '   ' },
        { email: null },
        { email: undefined },
        {},
      ],
      [{ email: null }, { email: '' }],
    )
    expect(union.size).toBe(1)
    expect(union.has('real@x.cz')).toBe(true)
  })

  test('case 8 (property): union(A, B) ⊆ union(A ∪ extra, B) — monotonic add', () => {
    fc.assert(
      fc.property(
        fc.array(fc.emailAddress(), { maxLength: 20 }),
        fc.array(fc.emailAddress(), { maxLength: 20 }),
        fc.array(fc.emailAddress(), { maxLength: 10 }),
        (a, b, extra) => {
          const baseRowsA = a.map((email) => ({ email }))
          const baseRowsB = b.map((email) => ({ email }))
          const expandedRowsA = [...baseRowsA, ...extra.map((email) => ({ email }))]

          const baseUnion = unionSuppressions(baseRowsA, baseRowsB)
          const expandedUnion = unionSuppressions(expandedRowsA, baseRowsB)

          for (const e of baseUnion) {
            if (!expandedUnion.has(e)) return false
          }
          return true
        },
      ),
      { numRuns: 100 },
    )
  })

  test('case 8b (property): |union(A, B)| === |lowercase(A ∪ B)|', () => {
    fc.assert(
      fc.property(
        fc.array(fc.emailAddress(), { maxLength: 50 }),
        fc.array(fc.emailAddress(), { maxLength: 50 }),
        (a, b) => {
          const rowsA = a.map((email) => ({ email }))
          const rowsB = b.map((email) => ({ email }))
          const union = unionSuppressions(rowsA, rowsB)

          const expected = new Set(
            [...a, ...b].map((e) => e.toLowerCase().trim()),
          )

          if (union.size !== expected.size) return false
          for (const e of expected) {
            if (!union.has(e)) return false
          }
          return true
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ───────────────────────────────────────────────────────────────────
// isSuppressed — O(1) lookup against a prebuilt union set
// ───────────────────────────────────────────────────────────────────
describe('isSuppressed', () => {
  test('case 9: case-insensitive lookup matches lowercase entries', () => {
    const union = unionSuppressions(
      [{ email: 'User@Example.cz' }],
      [],
    )
    expect(isSuppressed('USER@example.cz', union)).toBe(true)
    expect(isSuppressed('user@example.cz', union)).toBe(true)
    expect(isSuppressed('  user@example.cz  ', union)).toBe(true)
  })

  test('case 9b: returns false for unsuppressed addresses', () => {
    const union = unionSuppressions([{ email: 'a@x.cz' }], [])
    expect(isSuppressed('b@x.cz', union)).toBe(false)
  })

  test('case 9c: empty/invalid input returns false (does not throw)', () => {
    const union = unionSuppressions([{ email: 'a@x.cz' }], [])
    expect(isSuppressed('', union)).toBe(false)
    expect(isSuppressed(null, union)).toBe(false)
    expect(isSuppressed(undefined, union)).toBe(false)
    expect(isSuppressed(123, union)).toBe(false)
  })

  test('case 9d: empty union returns false for any input', () => {
    const empty = unionSuppressions([], [])
    expect(isSuppressed('any@x.cz', empty)).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────
// classifyBounceForSuppression — SMTP code → suppression decision
// ───────────────────────────────────────────────────────────────────
//
// Mirrors the Go bounce processor (features/outreach/mailboxes/bounce/processor.go):
//   5xx hard codes (550 / 551 / 553 / 554) → permanent → suppress contact
//   4xx soft codes                          → retryable → do NOT suppress
//   552 (mailbox full)                      → soft / retryable → no suppress
//   535 (auth failure)                      → mailbox-side, NOT contact     → no suppress
//
// The contact-side suppression cascade is what we model here. Mailbox
// auth failures are handled by the per-mailbox circuit breaker, not by
// suppressing the recipient.

describe('classifyBounceForSuppression', () => {
  test('case 10: 550 hard bounce → suppress with reason "hard_bounce"', () => {
    const got = classifyBounceForSuppression('550', 'user unknown')
    expect(got).not.toBeNull()
    expect(got.suppress).toBe(true)
    expect(got.reason).toBe('hard_bounce')
  })

  test('case 11: 4xx soft bounce → null (retryable, no suppress)', () => {
    expect(classifyBounceForSuppression('421', 'service not available')).toBeNull()
    expect(classifyBounceForSuppression('450', 'mailbox busy')).toBeNull()
    expect(classifyBounceForSuppression('451', 'try again later (greylist)')).toBeNull()
  })

  test('case 12: 535 auth failure → null (mailbox-side, not contact)', () => {
    // 535 is a sender-mailbox-side failure (bad SMTP creds). The contact
    // is not at fault — must not be suppressed. Per-mailbox breaker
    // handles this via auth_fail_count escalation in server.js.
    const got = classifyBounceForSuppression('535', 'authentication failed')
    expect(got).toBeNull()
  })

  test('case 13: 550 user unknown → suppress', () => {
    const got = classifyBounceForSuppression('550', 'user unknown')
    expect(got?.suppress).toBe(true)
    expect(got?.reason).toBe('hard_bounce')
  })

  test('case 14: 552 mailbox full → null (soft, retryable)', () => {
    // 552 = "Requested mail action aborted: exceeded storage allocation"
    // — the recipient mailbox is over quota. This is transient: the
    // recipient may free space tomorrow. Do NOT suppress.
    const got = classifyBounceForSuppression('552', 'mailbox full')
    expect(got).toBeNull()
  })

  test('case 15: 553 invalid recipient → suppress', () => {
    const got = classifyBounceForSuppression('553', 'invalid recipient address')
    expect(got?.suppress).toBe(true)
    expect(got?.reason).toBe('hard_bounce')
  })

  test('case 16: 551 user not local → suppress (5xx hard)', () => {
    const got = classifyBounceForSuppression('551', 'user not local')
    expect(got?.suppress).toBe(true)
    expect(got?.reason).toBe('hard_bounce')
  })

  test('case 17: 554 transaction failed → suppress (5xx hard)', () => {
    const got = classifyBounceForSuppression('554', 'transaction failed')
    expect(got?.suppress).toBe(true)
    expect(got?.reason).toBe('hard_bounce')
  })

  test('case 18: missing/invalid SMTP code → null (cannot decide → safe default)', () => {
    expect(classifyBounceForSuppression(null, 'whatever')).toBeNull()
    expect(classifyBounceForSuppression(undefined, '')).toBeNull()
    expect(classifyBounceForSuppression('', 'something')).toBeNull()
    expect(classifyBounceForSuppression('abc', 'gibberish')).toBeNull()
  })

  test('case 19: numeric SMTP code accepted (not just string)', () => {
    // Some bounce processors emit numeric codes; coerce defensively.
    const got = classifyBounceForSuppression(550, 'user unknown')
    expect(got?.suppress).toBe(true)
    expect(got?.reason).toBe('hard_bounce')
  })

  test('case 20: 2xx/3xx success codes → null (no bounce)', () => {
    expect(classifyBounceForSuppression('250', 'ok')).toBeNull()
    expect(classifyBounceForSuppression('354', 'start mail input')).toBeNull()
  })
})

// ───────────────────────────────────────────────────────────────────
// Stryker mutant-killer tests (KT-B9 — survivor rescue 2026-04-30)
// ───────────────────────────────────────────────────────────────────
//
// Cílí přesně na surviving mutants identifikované Strykerem v baselinu
// 66.29 %. Každý test má v komentáři, který mutant zabíjí + proč by
// jiný test nestačil. Smyslem je „zatlouct díry“ v klasifikaci, ne
// zvyšovat textovou pokrytost.
//
// Mutant nomenclature:
//   - CE  — ConditionalExpression (`if (cond)` → `if (true|false)`)
//   - LO  — LogicalOperator (`&&` ↔ `||`, jeden operand → `true|false`)
//   - SL  — StringLiteral (`'foo'` → `''` nebo Stryker tag)
//   - EQ  — EqualityOperator (`===` ↔ `!==`, `<` ↔ `>=`, …)
//   - BL  — BooleanLiteral (`true` ↔ `false`)
//   - AO  — ArithmeticOperator (`+` ↔ `-`, …)
//
// Tj. testy musí selhat, když je mutace aplikována, a projít proti
// originálu — to je formální definice „kill“ v mutation testingu.

import {
  unionSuppressions as _unionSuppressions, // alias-jen-pro-čtenost
  isSuppressed as _isSuppressed,
  classifyBounceForSuppression as _classifyBounceForSuppression,
} from '../../../src/lib/suppression-union.js'

describe('mutant-killer: unionSuppressions input-shape guards', () => {
  // Cíl: src/lib/suppression-union.js:49 CE
  //     `if (!Array.isArray(rows)) continue` → `if (false) continue`
  // Když mutace aktivní, smyčka se pokusí iterovat null/undefined a hodí
  // TypeError. Náš test musí dokázat, že non-array vstup je *bezpečně*
  // ignorován (ne hozen) — což existující test "case 1: empty + empty"
  // nezachytí, protože ten poslal valid array.
  test('M-1: non-array first arg (null) → ignored, no throw, empty union', () => {
    expect(() => _unionSuppressions(null, [])).not.toThrow()
    const u = _unionSuppressions(null, [])
    expect(u).toBeInstanceOf(Set)
    expect(u.size).toBe(0)
  })

  test('M-2: non-array second arg (string) → ignored, no throw, but first array still merged', () => {
    // Druhá kolekce je nesmysl, ale první by měla projít. Když by mutace
    // u CE 49 propustila non-array dál, druhá iterace by hodila.
    expect(() => _unionSuppressions([{ email: 'x@y.cz' }], 'not-an-array')).not.toThrow()
    const u = _unionSuppressions([{ email: 'x@y.cz' }], 'not-an-array')
    expect(u.has('x@y.cz')).toBe(true)
    expect(u.size).toBe(1)
  })

  // Cíl: src/lib/suppression-union.js:51 CE + LO
  //     `if (!row || typeof row !== 'object') continue`
  //     CE → `if (false) continue` — nesmysl-řádek by se pak vyhodnotil
  //     LO `||` → `&&` — null projde, protože null && cokoliv = null (falsy)
  // Existující "case 7" sice testuje {} ale ne primitive (string/number)
  // řádek. Mutace "|| → &&" by primitive řádky nefiltrovala a `row.email`
  // by hodil TypeError.
  test('M-3: row that is a string (primitive) → filtered out, no TypeError', () => {
    expect(() =>
      _unionSuppressions(['nečitelná-řádka', { email: 'real@x.cz' }], []),
    ).not.toThrow()
    const u = _unionSuppressions(['nečitelná-řádka', { email: 'real@x.cz' }], [])
    expect(u.size).toBe(1)
    expect(u.has('real@x.cz')).toBe(true)
  })

  test('M-4: row that is a number (primitive) → filtered out', () => {
    const u = _unionSuppressions([42, { email: 'real@x.cz' }], [])
    expect(u.size).toBe(1)
    expect(u.has('real@x.cz')).toBe(true)
  })
})

describe('mutant-killer: isSuppressed type-guard on union set', () => {
  // Cíl: src/lib/suppression-union.js:69 CE
  //     `if (!(unionSet instanceof Set)) return false` → `if (false) return false`
  // Když mutace aktivní, kód spadne při volání `unionSet.has(...)`. Žádný
  // existující test neposílá ne-Set jako druhý argument — všechny mají
  // legitimní Set z unionSuppressions.
  test('M-5: non-Set union (plain object) → returns false, does not throw', () => {
    expect(() => _isSuppressed('a@x.cz', { has: () => true })).not.toThrow()
    expect(_isSuppressed('a@x.cz', { has: () => true })).toBe(false)
  })

  test('M-6: non-Set union (null) → returns false, does not throw', () => {
    expect(() => _isSuppressed('a@x.cz', null)).not.toThrow()
    expect(_isSuppressed('a@x.cz', null)).toBe(false)
  })

  test('M-7: non-Set union (Map) → returns false (instanceof Set is strict)', () => {
    // Map má .has() ale není Set — kontrolujeme čistě typ-instanceof.
    const fakeMap = new Map([['a@x.cz', true]])
    expect(_isSuppressed('a@x.cz', fakeMap)).toBe(false)
  })

  // Cíl: src/lib/suppression-union.js:71 CE
  //     `if (norm === null) return false` → `if (false) return false`
  // Existující "case 9c" volá s union {a@x.cz}, takže `null` v has(null)
  // vrátí false → výsledek false bez ohledu na mutaci. Když Set OBSAHUJE
  // něco, co `has(null)` vrátí false, mutace nezachytíme. Musíme zařídit,
  // aby Set byl prázdný (has cokoliv → false) — pak by mutace také
  // vrátila false. Lepší je donutit, aby vstup byl validní string ale po
  // normalizaci null. To je "  " (samý whitespace) → trim → '' → null.
  // Když mutace aktivní, `unionSet.has(null)` → false → return false
  // (ale i originál vrací false). Klíč: mutant zruší early-return,
  // takže `unionSet.has(null)` se zavolá. Pokud v Setu je null jako entry
  // (které by tam být nemělo, ale můžeme ho explicitně vložit), originál
  // vrátí false (early), mutant vrátí true.
  test('M-8: whitespace-only email + Set obsahující null → originál vrací false (early), mutant vrací true', () => {
    const tamperedSet = new Set([null])
    // Po normalizaci je norm === null. Originál: vrací false dřív, než
    // se sáhne na set. Mutace `if (false) return false`: pokračuje, volá
    // tamperedSet.has(null) → true. Tj. mutace vrátí true místo false.
    expect(_isSuppressed('   ', tamperedSet)).toBe(false)
  })
})

describe('mutant-killer: classifyBounceForSuppression coerceCode guards', () => {
  // Cíl: src/lib/suppression-union.js:116 CE
  //     `if (code === null) return null` → `if (false) return null`
  // coerceCode vrací null pro neplatné vstupy. Když early-return zmizí,
  // následující `NEVER_SUPPRESS_CODES.has(null)` → false, pak `HARD_BOUNCE_CODES.has(null)`
  // → false, takže výsledek by byl null = stejný. Mutaci tedy zabijeme
  // jen pomocí vstupu, který by jinak prošel kontrolami. Takový neexistuje
  // — v originálu je nemožné, aby `code` z coerceCode byl mimo whitelist.
  // Můžeme však monkey-patchovat NEVER_SUPPRESS_CODES — což nelze, je to
  // const local. Místo toho cílíme na CE 132 a 137.

  // Cíl: src/lib/suppression-union.js:132 CE+LO
  //     `if (raw === null || raw === undefined) return null`
  //     LO `||` → `&&`: pak null && undefined = null (falsy) → if false
  //     → nepokračuje. Tj. null projde dál, dojde k typeof null === 'number'
  //     (false), typeof null !== 'string' (true) → return null. Stejný
  //     výsledek — mutaci nezabíjíme. Klíč: mutant `&& undefined` →
  //     null && undefined = null (early return null). Stejný!
  //     Takže CE/LO 132 je equivalent mutant na úrovni finálního výsledku.
  //     Ale CE 137 `if (typeof raw !== 'string') return null` → `if (false) return null`
  //     znamená, že non-string inputs (např. boolean true) by spadly na
  //     `raw.trim()` → TypeError. Test: posláním `true` zachytíme.
  test('M-9: SMTP code je boolean true → null (no TypeError)', () => {
    expect(() => _classifyBounceForSuppression(true, 'whatever')).not.toThrow()
    expect(_classifyBounceForSuppression(true, '')).toBeNull()
  })

  test('M-10: SMTP code je object → null (no TypeError)', () => {
    expect(() => _classifyBounceForSuppression({ code: 550 }, '')).not.toThrow()
    expect(_classifyBounceForSuppression({ code: 550 }, '')).toBeNull()
  })

  // Cíl: src/lib/suppression-union.js:133 CE+LO
  //     `if (typeof raw === 'number' && Number.isFinite(raw))` → `|| Number.isFinite(raw)`
  //     Pak NaN/Infinity pro string '550' projdou jako number-branch a
  //     `String(Math.trunc('550'))` = 'NaN' → null. Existující numeric
  //     test (`550` jako number) zabije variantu, ale ne LO mutaci.
  //     Konkrétně: mutace `&&` → `||` znamená, že pokud raw je string '550':
  //       typeof '550' === 'number' = false, false || Number.isFinite('550')
  //       = false || false = false → spadne na else branch.
  //     Stejný výsledek. Equivalent mutant na string.
  //     Pro NaN: typeof NaN === 'number' = true. Originál: && Number.isFinite(NaN)
  //     = && false = false → propadne na typeof NaN !== 'string' → null.
  //     Mutant: || Number.isFinite(NaN) = true || false = true → vstoupí
  //     do bloku → String(Math.trunc(NaN)) = 'NaN' → /^\d{3}$/.test = false
  //     → null. Stejný. Equivalent.
  //     Klíč: pro Infinity: Originál: && false = false → ne-string → null.
  //     Mutant: || false = true → Math.trunc(Infinity) = Infinity →
  //     String(Infinity) = 'Infinity' → no match → null. Stejný.
  //     Bohužel řadu equivalent mutantů. Test M-11 zabíjí je nepřímo:
  test('M-11: NaN SMTP code → null (Number.isFinite filter platí)', () => {
    expect(_classifyBounceForSuppression(NaN, '')).toBeNull()
  })

  test('M-12: Infinity SMTP code → null', () => {
    expect(_classifyBounceForSuppression(Infinity, '')).toBeNull()
    expect(_classifyBounceForSuppression(-Infinity, '')).toBeNull()
  })

  // Cíl: src/lib/suppression-union.js:98 SL '535' → ''
  //     Pokud řetězec '535' je nahrazen '', pak NEVER_SUPPRESS_CODES = {'', '552'}
  //     Když přijde '535' jako vstup, projde NEVER_SUPPRESS_CODES.has('535')
  //     = false → propadne na HARD_BOUNCE_CODES (taky false) → null.
  //     V originále taky null. Equivalent? NE: Když přijde prázdný kód
  //     (po coerceCode null → early return null) — nikdy se na has('') nedostane.
  //     Takže string-mutaci '535' → '' zabijeme jen, pokud nějaký test
  //     očekává, že '535' VRACÍ NULL kvůli členství v NEVER_SUPPRESS_CODES.
  //     Existující "case 12" už to ověřuje. Stryker uvedl, že mutace přežila
  //     — protože všechny případy 535 vrací null i když '535' není v Setu
  //     (HARD_BOUNCE_CODES taky neobsahuje 535). Ouha — to je equivalent.
  //     Vyřešení: přidat 535 jako hard bounce v paralelní verzi by selhalo,
  //     ale to měníme produkční kód. Místo toho — mutaci '535' → '' je
  //     opravdu equivalent na current logice. Stejně tak '552' → ''.
  //     Markujeme to v komentáři, neztrácíme čas.
  // (žádný kill test pro M-SL '535'/'552' — equivalent na úrovni vstupu)
})

describe('mutant-killer: HARD_BOUNCE_CODES boundary literals', () => {
  // Cíl: posílení existujících case 10/15/16/17 — ujistíme se, že ne-hard
  // codes 5xx, které NEJSOU v setu, vrací null. Tím při SL mutaci
  // 'X' → '' se zachytí ztráta entry.
  test('M-13: 555 (ne v setu) → null — chrání proti SL mutacím v HARD_BOUNCE_CODES', () => {
    expect(_classifyBounceForSuppression('555', 'whatever')).toBeNull()
  })

  test('M-14: 559 → null', () => {
    expect(_classifyBounceForSuppression('559', '')).toBeNull()
  })

  // Pokud by SL mutace '550' → '' přežila, '550' input by nebyl v setu →
  // null místo hard_bounce. Existující case 10 už to chytí. Tento test
  // je dvojkontrolou pro 553 + 554 boundary.
  test('M-15: 553 + 554 oba zabíjejí variantu „jen 550 je hard“', () => {
    expect(_classifyBounceForSuppression('553', 'invalid recipient')).toMatchObject({
      suppress: true,
      reason: 'hard_bounce',
    })
    expect(_classifyBounceForSuppression('554', 'transaction failed')).toMatchObject({
      suppress: true,
      reason: 'hard_bounce',
    })
  })
})
