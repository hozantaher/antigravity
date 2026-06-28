/**
 * Unit tests for replyClassifier.js — S19 IMAP auto-classify.
 * TDD: tests are the source of truth.
 * Run: pnpm test src/lib/replyClassifier
 */
import { describe, it, expect } from 'vitest'
import {
  classifyReplyBody,
  classifyReply,
  stripQuotedReply,
  CLASSIFIER_VERSION,
  AUTO_APPLY_THRESHOLD,
  BANNER_VISIBLE_THRESHOLD,
} from '../../../src/lib/replyClassifier'

// ── Negative / unsubscribe ────────────────────────────────────────────────────

describe('classifyReplyBody — negative', () => {
  it('"Nemáme zájem" → negative', () => {
    expect(classifyReplyBody('Nemáme zájem o vaši nabídku.')).toBe('negative')
  })

  it('"Unsubscribe" (standalone) → negative', () => {
    expect(classifyReplyBody('Unsubscribe')).toBe('negative')
  })

  it('"Please remove me from your list" → negative', () => {
    expect(classifyReplyBody('Please remove me from your list, thank you.')).toBe('negative')
  })

  it('"opt out" with space → negative', () => {
    expect(classifyReplyBody('I would like to opt out of these emails.')).toBe('negative')
  })

  it('"Not interested" → negative', () => {
    expect(classifyReplyBody('Not interested, please stop contacting me.')).toBe('negative')
  })

  it('"No thank you" → negative', () => {
    expect(classifyReplyBody('No thank you, we have our own suppliers.')).toBe('negative')
  })
})

// ── OOO ──────────────────────────────────────────────────────────────────────

describe('classifyReplyBody — ooo', () => {
  it('"Out of office until Monday" → ooo', () => {
    expect(classifyReplyBody('Out of office until Monday. I will reply when I return.')).toBe('ooo')
  })

  it('"Mimo kancelář" (CZ) → ooo', () => {
    expect(classifyReplyBody('Mimo kancelář do 30. dubna. Urgentní záležitosti pošlete...')).toBe('ooo')
  })

  it('"dovolená" → ooo', () => {
    expect(classifyReplyBody('Jsem na dovolené do konce týdne.')).toBe('ooo')
  })

  it('"nepřítomen" → ooo', () => {
    expect(classifyReplyBody('Momentálně jsem nepřítomen, odpovím po návratu.')).toBe('ooo')
  })
})

// ── Interested ────────────────────────────────────────────────────────────────

describe('classifyReplyBody — interested', () => {
  it('"Rád bych se dozvěděl více" → interested', () => {
    expect(classifyReplyBody('Rád bych se dozvěděl více o vaší nabídce.')).toBe('interested')
  })

  it('"Tell me more about pricing" → interested', () => {
    expect(classifyReplyBody('Tell me more about pricing and availability.')).toBe('interested')
  })

  it('"Zájem máme, pošlete katalog" → interested', () => {
    expect(classifyReplyBody('Zájem máme, pošlete nám prosím katalog.')).toBe('interested')
  })

  it('"Domluvme schůzku" → interested', () => {
    expect(classifyReplyBody('Domluvme schůzku na příští týden.')).toBe('interested')
  })
})

// ── Question ─────────────────────────────────────────────────────────────────

describe('classifyReplyBody — question', () => {
  it('short question with ? → question', () => {
    expect(classifyReplyBody('Kolik to stojí?')).toBe('question')
  })

  it('question under 200 chars → question', () => {
    expect(classifyReplyBody('Jaká je vaše cena pro 3 kusy?')).toBe('question')
  })

  it('long body with ? (>=200 chars) → unknown (not question)', () => {
    const longBody = 'Chtěli bychom se zeptat na vaši nabídku, protože jsme si vědomí různých možností na trhu a rádi bychom porovnali vaše podmínky s konkurencí. Mohli byste nám zaslat cenovou nabídku pro naši firmu? Děkujeme.'
    expect(longBody.length).toBeGreaterThanOrEqual(200)
    // Falls through to 'unknown' because body >= 200 chars
    expect(classifyReplyBody(longBody)).toBe('unknown')
  })
})

// ── Unknown / edge cases ──────────────────────────────────────────────────────

describe('classifyReplyBody — unknown / edge cases', () => {
  it('empty string → unknown', () => {
    expect(classifyReplyBody('')).toBe('unknown')
  })

  it('null → unknown', () => {
    expect(classifyReplyBody(null)).toBe('unknown')
  })

  it('undefined → unknown', () => {
    expect(classifyReplyBody(undefined)).toBe('unknown')
  })

  it('plain unrelated text → unknown', () => {
    expect(classifyReplyBody('Dekuji za zprávu, budu reagovat.')).toBe('unknown')
  })
})

// ── Priority: OOO wins over other signals ────────────────────────────────────

describe('classifyReplyBody — OOO priority', () => {
  it('OOO + negative keywords → ooo wins', () => {
    // "out of office" and "not interested" both present — ooo should win
    const mixed = 'Out of office until Friday. Not interested in any offers while away.'
    expect(classifyReplyBody(mixed)).toBe('ooo')
  })

  it('OOO + interested keywords → ooo wins', () => {
    const mixed = 'Out of office. I am interested but will reply when I return.'
    expect(classifyReplyBody(mixed)).toBe('ooo')
  })

  it('mixed OOO + unsubscribe (CZ) → ooo wins', () => {
    const mixed = 'Mimo kancelář. Odhlásit se chci až po návratu.'
    expect(classifyReplyBody(mixed)).toBe('ooo')
  })
})

// ── MONKEY test: 500 random strings → always valid category, never crash ─────

describe('classifyReplyBody — monkey / property test', () => {
  const VALID = new Set(['ooo', 'negative', 'interested', 'question', 'unknown'])

  function randomString(len) {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGH áéíóúůčšžřýě?!.,\n\t01234'
    let s = ''
    for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)]
    return s
  }

  it('500 random strings — always returns a valid category, never throws', () => {
    for (let i = 0; i < 500; i++) {
      const len = Math.floor(Math.random() * 400)
      const input = randomString(len)
      let result
      expect(() => { result = classifyReplyBody(input) }).not.toThrow()
      expect(VALID.has(result)).toBe(true)
    }
  })

  it('100 random non-string values — always returns unknown, never throws', () => {
    const nonStrings = [0, 1, -1, true, false, {}, [], NaN, Infinity, Symbol('x')]
    for (let i = 0; i < 100; i++) {
      const input = nonStrings[i % nonStrings.length]
      let result
      expect(() => { result = classifyReplyBody(input) }).not.toThrow()
      expect(result).toBe('unknown')
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════
// AV-F2 — extended classifier (classifyReply)
// ═════════════════════════════════════════════════════════════════════════

describe('AV-F2 classifyReply — constants', () => {
  it('exports a fixed classifier version', () => {
    expect(CLASSIFIER_VERSION).toBe('regex_v2')
  })
  it('AUTO_APPLY_THRESHOLD is between 0 and 1', () => {
    expect(AUTO_APPLY_THRESHOLD).toBeGreaterThan(0)
    expect(AUTO_APPLY_THRESHOLD).toBeLessThanOrEqual(1)
  })
  it('BANNER_VISIBLE_THRESHOLD is lower than AUTO_APPLY_THRESHOLD', () => {
    expect(BANNER_VISIBLE_THRESHOLD).toBeLessThan(AUTO_APPLY_THRESHOLD)
  })
})

describe('AV-F2 classifyReply — bounce', () => {
  it('postmaster sender → bounce 0.99', () => {
    const v = classifyReply('hello', 'Re: nabídka', 'postmaster@seznam.cz')
    expect(v.classification).toBe('bounce')
    expect(v.confidence).toBeCloseTo(0.99, 2)
  })

  it('MAILER-DAEMON sender → bounce', () => {
    const v = classifyReply('', 'Delivery error', 'MAILER-DAEMON@example.com')
    expect(v.classification).toBe('bounce')
  })

  it('"Undeliverable" subject → bounce', () => {
    const v = classifyReply('', 'Undeliverable: your message', 'unknown@example.com')
    expect(v.classification).toBe('bounce')
  })

  it('DSN body pattern "550 5.1.1" → bounce', () => {
    const v = classifyReply('550 5.1.1 user@example.com not found', 'Notice', 'a@b.cz')
    expect(v.classification).toBe('bounce')
  })

  it('"Mail Delivery System" subject → bounce', () => {
    const v = classifyReply('', 'Mail Delivery System Notification', 'mail@server')
    expect(v.classification).toBe('bounce')
  })
})

describe('AV-F2 classifyReply — unsubscribe', () => {
  it('"Unsubscribe" in body → unsubscribe 0.95', () => {
    const v = classifyReply('Please unsubscribe me from this list', '', 'a@b.cz')
    expect(v.classification).toBe('unsubscribe')
    expect(v.confidence).toBeCloseTo(0.95, 2)
  })

  it('"Chci se odhlásit" CZ → unsubscribe', () => {
    const v = classifyReply('Chci se odhlásit z newsletteru.', '', 'a@b.cz')
    expect(v.classification).toBe('unsubscribe')
  })
})

describe('AV-F2 classifyReply — auto_reply', () => {
  it('"Out of Office" subject → auto_reply 0.90', () => {
    const v = classifyReply('Mám se zpět v pondělí', 'Out of Office', 'p@firma.cz')
    expect(v.classification).toBe('auto_reply')
    expect(v.confidence).toBeCloseTo(0.9, 2)
  })

  it('"Mimo kancelář" subject → auto_reply', () => {
    const v = classifyReply('', 'Mimo kancelář do 25.5.', 'p@firma.cz')
    expect(v.classification).toBe('auto_reply')
  })

  it('"jsem mimo" body → auto_reply', () => {
    const v = classifyReply('Dobrý den, jsem mimo do pátku, ozvu se.', '', 'p@firma.cz')
    expect(v.classification).toBe('auto_reply')
  })
})

describe('AV-F2 classifyReply — negative (must fire BEFORE selling)', () => {
  it('"Nemáme bagr" → negative not positive (contains "máme")', () => {
    const v = classifyReply('Nemáme bagr na prodej, díky.', '', 'p@firma.cz')
    expect(v.classification).toBe('negative')
    expect(v.confidence).toBeCloseTo(0.85, 2)
  })

  it('"Nezájem" → negative', () => {
    const v = classifyReply('Nezájem.', '', 'p@firma.cz')
    expect(v.classification).toBe('negative')
  })

  it('"neprodáváme" → negative', () => {
    const v = classifyReply('Bohužel neprodáváme, jsme stavební firma.', '', 'p@firma.cz')
    expect(v.classification).toBe('negative')
  })

  it('"nezajem" ASCII variant → negative', () => {
    const v = classifyReply('Nezajem o nabidku.', '', 'p@firma.cz')
    expect(v.classification).toBe('negative')
  })
})

describe('AV-F2 classifyReply — positive (selling intent + brand/machine bonus)', () => {
  it('"máme na prodej" only → positive 0.80', () => {
    const v = classifyReply('Máme jeden kus na prodej.', '', 'p@firma.cz')
    expect(v.classification).toBe('positive')
    expect(v.confidence).toBeCloseTo(0.8, 2)
  })

  it('"máme Hitachi" → positive with brand bonus → 0.90', () => {
    const v = classifyReply('Máme na prodej Hitachi ZX 130.', '', 'p@firma.cz')
    expect(v.classification).toBe('positive')
    expect(v.confidence).toBeCloseTo(0.9, 2)
  })

  it('"prodáme bagr Komatsu" → positive with brand + machine, capped at 0.95', () => {
    const v = classifyReply('Prodáme bagr Komatsu PC210.', '', 'p@firma.cz')
    expect(v.classification).toBe('positive')
    expect(v.confidence).toBeCloseTo(0.95, 2)
  })

  it('"nabízíme valník" → positive with machine bonus 0.85', () => {
    const v = classifyReply('Nabízíme valník v dobrém stavu.', '', 'p@firma.cz')
    expect(v.classification).toBe('positive')
    expect(v.confidence).toBeCloseTo(0.85, 2)
  })

  it('"k prodeji" CZ B2B phrasing → positive', () => {
    const v = classifyReply('K prodeji máme jeden Liebherr.', '', 'p@firma.cz')
    expect(v.classification).toBe('positive')
  })
})

describe('AV-F2 classifyReply — question', () => {
  it('short body ending with ? → question 0.65', () => {
    const v = classifyReply('Kolik to stojí?', '', 'p@firma.cz')
    expect(v.classification).toBe('question')
    expect(v.confidence).toBeCloseTo(0.65, 2)
  })

  it('"Kde najdu specifikaci" → question via phrase', () => {
    const v = classifyReply('Kde najdu detailní specifikaci stroje.', '', 'p@firma.cz')
    expect(v.classification).toBe('question')
  })
})

describe('AV-F2 classifyReply — fallback / null', () => {
  it('empty body + no signals → null with low confidence', () => {
    const v = classifyReply('', '', '')
    expect(v.classification).toBeNull()
    expect(v.confidence).toBeCloseTo(0.3, 2)
  })

  it('neutral text → null', () => {
    const v = classifyReply('Děkuji za zprávu.', '', 'p@firma.cz')
    expect(v.classification).toBeNull()
  })
})

describe('AV-F2 classifyReply — reasoning shape', () => {
  it('every verdict carries matched_patterns + classifier_version', () => {
    const v = classifyReply('Máme bagr na prodej.', '', 'p@firma.cz')
    expect(v.reasoning).toBeDefined()
    expect(v.reasoning.classifier_version).toBe('regex_v2')
    expect(Array.isArray(v.reasoning.matched_patterns)).toBe(true)
    expect(v.reasoning.matched_patterns.length).toBeGreaterThan(0)
  })

  it('score_breakdown is an object', () => {
    const v = classifyReply('Out of office', 'OOO', 'a@b.cz')
    expect(typeof v.reasoning.score_breakdown).toBe('object')
  })

  it('null / undefined inputs do not throw', () => {
    expect(() => classifyReply(null, null, null)).not.toThrow()
    expect(() => classifyReply(undefined, undefined, undefined)).not.toThrow()
  })
})

describe('AV-F2 classifyReply — diacritics + multiline + mixed signals', () => {
  it('multiline body with positive in line 3 → positive', () => {
    const body = [
      'Dobrý den,',
      'děkuji za nabídku.',
      'Máme na prodej Hitachi ZX 130.',
      'S pozdravem',
    ].join('\n')
    const v = classifyReply(body, '', 'p@firma.cz')
    expect(v.classification).toBe('positive')
  })

  it('mixed signals: bounce wins over selling', () => {
    const v = classifyReply(
      'Recipient mailbox unavailable. We have on offer many items.',
      'Failure notice',
      'postmaster@seznam.cz',
    )
    expect(v.classification).toBe('bounce')
  })

  it('mixed signals: unsubscribe wins over question', () => {
    const v = classifyReply('Unsubscribe me. Co dál?', '', 'a@b.cz')
    expect(v.classification).toBe('unsubscribe')
  })

  it('Czech diacritics: "máme" with diacritic matches', () => {
    const v = classifyReply('Máme bagr.', '', 'p@firma.cz')
    expect(v.classification).toBe('positive')
  })

  it('Czech ASCII fallback: "mame" without diacritic matches', () => {
    const v = classifyReply('Mame bagr.', '', 'p@firma.cz')
    expect(v.classification).toBe('positive')
  })
})

// 2026-05-31 — decline phrases that leaked to 'positive' before the NEGATIVE_RX
// extension (negation didn't fire → a brand/selling keyword elsewhere matched).
describe('classifyReply (AV-F2) — decline phrases must beat selling/brand', () => {
  const neg = (b) => classifyReply(b, '', 'p@firma.cz').classification
  it('"nehodláme prodávat" → negative (not positive via "prodávat")', () => {
    expect(neg('Tento typ techniky nehodláme prodávat.')).toBe('negative')
  })
  it('"nezabývám se ... jsem geodet" → negative', () => {
    expect(neg('Nezabývám se zemní technikou, jsem geodet.')).toBe('negative')
  })
  it('"nechci" → negative', () => {
    expect(neg('Děkuji, nechci.')).toBe('negative')
  })
  it('"vyřaďte mě" → negative', () => {
    expect(neg('Vyřaďte mě prosím z databáze.')).toBe('negative')
  })
  it('"není zájem" → negative', () => {
    expect(neg('Dobrý den, není zájem.')).toBe('negative')
  })
  it('"neprodávám" (singular) → negative', () => {
    expect(neg('Nic neprodávám, díky.')).toBe('negative')
  })
  it('"nemám na prodej nic" → negative (beats SELLING "na prodej")', () => {
    expect(neg('Dobrý den, bohužel nemám na prodej nic.')).toBe('negative')
  })
  // Non-regression: genuine offers stay positive.
  it('REGRESE: "Máme na prodej bagr" → positive', () => {
    expect(neg('Máme na prodej bagr Caterpillar 312.')).toBe('positive')
  })
  it('REGRESE: "Prodáváme Tatra" → positive', () => {
    expect(neg('Prodáváme nákladní Tatra, volejte.')).toBe('positive')
  })
})

// 2026-05-31 — leading curt decline ("NE.") must beat a later selling/brand
// keyword in a signature or quoted original mail. (reply_inbox id 99 was stuck
// unclassified; would have auto-applied 'positive' once the cron's 24h lookback
// was removed — this guard keeps it 'negative'.)
describe('classifyReply (AV-F2) — leading curt decline', () => {
  const cls = (b) => classifyReply(b, '', 'p@firma.cz').classification
  it('"NE. S pozdravem … Izolace" → negative (not positive via signature)', () => {
    expect(cls('NE. S pozdravem Richard Šůs jednatel ISO – Izolace stavebních objektů')).toBe('negative')
  })
  it('"Ne!" → negative', () => {
    expect(cls('Ne! Děkuji.')).toBe('negative')
  })
  // Non-regression: leading "Ne" without curt punctuation keeps normal flow.
  it('REGRESE: "Nedávno … máme na prodej bagr" → positive (not a decline)', () => {
    expect(cls('Nedávno jsme koupili, máme na prodej bagr Caterpillar.')).toBe('positive')
  })
  it('REGRESE: "Ne, ale mám bagr na prodej" → positive (comma continues)', () => {
    expect(cls('Ne, ale mám bagr na prodej.')).toBe('positive')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// regex_v2 (2026-05-31) — quote-stripping + price/offer + short-decline.
//
// Source of truth: 12 REAL reply_inbox rows classified 'positive' that, on
// eyeballing the bodies, were actually declines (the regex matched the
// SELLING keywords inside OUR OWN quoted outbound "máte na prodej?"). Bodies
// below mirror the real phrasing + quote structure; PII (names/phones/emails)
// is redacted to placeholders — the classification signal is the Czech
// decline/offer phrasing + the quote markers, not the identity.
// Per feedback_no_fabricated_test_data: real structure, redacted identifiers.
// ════════════════════════════════════════════════════════════════════════════

describe('stripQuotedReply — cut at reply-history markers', () => {
  it('strips a "SELČ, … napsal:" + ">" quoted block', () => {
    const body = 'Nemám žádná auta.\n29. května 2026 10:05:47 SELČ, Hozan Taher <x@post.cz> napsal:\n>Dobry den,\n>máte na prodej?'
    expect(stripQuotedReply(body)).toBe('Nemám žádná auta.')
  })
  it('strips a "Původní e-mail" separator', () => {
    const body = 'Cena 195000,- korun.\n---------- Původní e-mail ----------\nOd: Hozan Taher <x@post.cz>'
    expect(stripQuotedReply(body)).toBe('Cena 195000,- korun.')
  })
  it('strips "Dne … napsal(a):"', () => {
    const body = 'Nekontaktujte mě, děkuji\nDne 28.05.2026 v 17:53 Hozan Taher napsal(a):\n> Dobry den'
    expect(stripQuotedReply(body)).toBe('Nekontaktujte mě, děkuji')
  })
  it('strips an English "On … wrote:" block', () => {
    const body = 'I have nothing.\n> On 26 May 2026, at 09:32, Hozan Taher <x@post.cz> wrote:\n> hi'
    expect(stripQuotedReply(body)).toBe('I have nothing.')
  })
  it('returns the input unchanged when there is no quote', () => {
    expect(stripQuotedReply('Cena bez DPH 980.000,-')).toBe('Cena bez DPH 980.000,-')
  })
  it('falls back to the full body if stripping would empty it', () => {
    const onlyQuote = '> Dobry den\n> máte na prodej?'
    expect(stripQuotedReply(onlyQuote).length).toBeGreaterThan(0)
  })
})

describe('classifyReply regex_v2 — declines that leaked to positive', () => {
  const v = (b) => classifyReply(b, '', 'seller@firma.cz').classification
  const Q = '\n29. května 2026 10:05:47 SELČ, Hozan Taher <x@post.cz> napsal:\n>Dobry den,\n>zkousim Vas oslovit. Mate u Vas neco na prodej? Vykoupim.'

  it('"Nemám žádná auta." + quoted pitch → negative (was positive)', () => {
    expect(v('Nemám žádná auta.' + Q)).toBe('negative')
  })
  it('"Momentálně ne" + quoted pitch → negative', () => {
    expect(v('Momentálně ne' + Q)).toBe('negative')
  })
  it('"aktuálně ne" mid-greeting + quoted pitch → negative', () => {
    expect(v('Dobrý den, aktuálně ne. S pozdravem' + Q)).toBe('negative')
  })
  it('bare "Nemám" + signature + quote → negative', () => {
    expect(v('Nemám\nJan N.\nOdesláno z iPhonu\n> 22. 5. 2026 v 16:07, Hozan Taher <x@post.cz>:\n> Dobry den')).toBe('negative')
  })
  it('"já nic nemám" + quote → negative', () => {
    expect(v('Dobý den, já nic nemám. Můj bytný má v garáži žigulíky.\n> On 26 May 2026, at 09:32, Hozan Taher wrote:')).toBe('negative')
  })
  it('"Nekontaktujte mě, děkuji" → unsubscribe (opt-out, not positive)', () => {
    expect(v('Nekontaktujte mě, děkuji\nDne 28.05.2026 v 17:53 Hozan Taher napsal(a):\n> Dobry den')).toBe('unsubscribe')
  })
})

describe('classifyReply regex_v2 — genuine price offers stay positive', () => {
  const v = (b) => classifyReply(b, '', 'seller@firma.cz').classification

  it('"Cena bez DPH 980.000,-" + signature → positive', () => {
    expect(v('Cena bez DPH 980.000,-\nPřeji prima den\nMartin K.\nDispečer')).toBe('positive')
  })
  it('"cena 195000,- korun" before quote → positive', () => {
    expect(v('Zitra bude mít novou STK cena 195000,- korun DPH není.\n---------- Původní e-mail ----------\nOd: Hozan Taher')).toBe('positive')
  })
  it('does NOT count a price that only appears in the quoted original', () => {
    // The recipient said nothing of substance; the price is in OUR quote.
    expect(v('Dobrý den\n> Nabízíme bagr za 500000,- Kč')).not.toBe('positive')
  })
})

describe('classifyReply regex_v2 — questions survive quote-strip', () => {
  const v = (b) => classifyReply(b, '', 'seller@firma.cz').classification
  it('"Stroje taky?" + quote → question', () => {
    expect(v('Co mate na mysli ? Stroje taky ?\n> 21. 5. 2026 v 16:14, Hozan Taher <x@post.cz>:')).toBe('question')
  })
})
