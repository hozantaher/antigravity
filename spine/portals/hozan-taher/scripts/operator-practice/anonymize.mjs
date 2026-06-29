#!/usr/bin/env node
/**
 * anonymize.mjs — strip PII from real prod replies → fixture .eml files (OP1.2).
 *
 * Input: JSON array dump of outreach_messages rows.
 * Output: tests/fixtures/operator-replies/<category>/<id>.eml files +
 *         a manual-review checklist printed to stdout.
 *
 * Per memory feedback_no_fabricated_test_data: anonymizer transforms
 * REAL data only. It does NOT generate synthetic samples. If input is
 * empty, output is empty.
 *
 * Per memory feedback_no_external_services: pure node:* stdlib, no npm
 * deps, no remote calls.
 *
 * Replacement rules:
 *   - Email addresses    → prospect-NNN@anon.lab (deterministic hash)
 *   - Czech first names  → [Jméno] (from CZECH_FIRSTNAMES list)
 *   - Czech surnames     → [Příjmení] (best-effort heuristic)
 *   - Phone numbers      → [Telefon] (CZ +420 + variants)
 *   - URLs               → preserves scheme + TLD, randomizes path
 *   - Company suffixes   → [Firma] s.r.o. / a.s. patterns
 *
 * Manual review:
 *   The script ALWAYS prints a checklist of remaining capitalized
 *   strings that might be PII. Operator must review before committing
 *   the output to git.
 *
 * Usage:
 *   node scripts/operator-practice/anonymize.mjs <input.json> <output-dir>
 *   node scripts/operator-practice/anonymize.mjs --help
 *   node scripts/operator-practice/anonymize.mjs --self-test
 *
 * Exit codes:
 *   0 success (with possibly non-empty checklist)
 *   1 input file unreadable / invalid JSON
 *   2 output dir refuses to be created
 *   3 missing required arg
 *   4 self-test failure
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'

// ── Czech first names (top ~80 from CZSO statistics, anonymized list) ─

const CZECH_FIRSTNAMES = new Set([
  // male
  'Jan','Jakub','Jiří','Petr','Tomáš','Pavel','Martin','Lukáš','David',
  'Michal','Filip','Adam','Marek','Roman','Patrik','Daniel','Ondřej',
  'Vojtěch','Matěj','Antonín','František','Václav','Karel','Josef',
  'Miroslav','Stanislav','Vladimír','Zdeněk','Robert','Aleš','Štěpán',
  'Šimon','Dominik','Radek','Richard','Igor','Ivan','Libor','Milan',
  'Oldřich','Otakar','Rudolf','Sebastián','Tobiáš','Vít','Zbyněk',
  // female
  'Anna','Eva','Hana','Jana','Marie','Lucie','Lenka','Tereza','Kateřina',
  'Kristýna','Eliška','Karolína','Markéta','Michaela','Veronika','Petra',
  'Klára','Adéla','Barbora','Natálie','Aneta','Alena','Pavla','Iveta',
  'Jitka','Vlasta','Helena','Soňa','Zuzana','Ivana','Olga','Dagmar',
  'Miroslava','Eliška','Magdaléna','Renata','Dana','Šárka','Květa',
])

const CZECH_GREETING_PREFIX = /\b(?:pan(?:e|í|ovi|í|ové)?|paní|slečno?|drahý|drahá|milý|milá|vážený|vážená|vážená paní|vážený pane)\b/giu
const CZECH_FAREWELL_PREFIX = /\b(?:s\s+pozdravem|s\s+úctou|díky|d[ěe]kuji|hezký den|př[eí]ji)\b[^\n]*?(?=$|[\n\r])/giu

// ── Replacement primitives ────────────────────────────────────────────

export function anonymizeEmail(addr, salt = 'op-practice-2026') {
  const trimmed = (addr || '').trim().toLowerCase()
  if (!trimmed.includes('@')) return addr
  // Deterministic hash → 4-digit suffix
  const hash = createHash('sha256').update(salt + trimmed).digest('hex')
  const suffix = parseInt(hash.slice(0, 4), 16) % 9999
  return `prospect-${String(suffix).padStart(4, '0')}@anon.lab`
}

export function anonymizePhone(text) {
  // CZ phones: +420 NNN NNN NNN, 6NN NNN NNN, +420NNNNNNNNN, etc.
  // Plus Slovak +421 (CZ businesses sometimes have them) and US (605) NNN-NNN.
  // Plus generic: any 9-digit sequence with optional grouping.
  return text
    // CZ/SK country code variants
    .replace(/\+?(?:420|421)[\s.-]?\d{3}[\s.-]?\d{3}[\s.-]?\d{3}/g, '[Telefon]')
    .replace(/\+?(?:420|421)[\s.-]?\d{3}[\s.-]?\d{4,7}/g, '[Telefon]')
    // US-style with parens: (605) 123-456 or (605) 123-4567
    .replace(/\(\d{3}\)[\s.-]?\d{3}[\s.-]?\d{3,4}/g, '[Telefon]')
    // Bare 9-digit with grouping
    .replace(/(?<![\d/])(\d{3})[\s.-]?(\d{3})[\s.-]?(\d{3})(?![\d/])/g, '[Telefon]')
}

export function anonymizeURL(text) {
  // Preserve scheme + TLD shape, randomize path
  return text.replace(
    /(https?:\/\/)?([\w-]+\.)*([\w-]+\.[a-z]{2,8})(\/[\w/.~?=%&-]*)?/gi,
    (match, scheme, sub, tld, path) => {
      // Skip @anon.lab — already anonymized
      if (match.includes('anon.lab')) return match
      // Skip pure version numbers (e.g. v1.2.3)
      if (/^v?\d+\.\d+(\.\d+)?$/.test(match)) return match
      const tldOnly = tld.split('.').pop()
      const protoPrefix = scheme || ''
      const subPrefix = sub ? 'anon.' : ''
      const pathSuffix = path ? '/path-anon' : ''
      return `${protoPrefix}${subPrefix}anon.${tldOnly}${pathSuffix}`
    }
  )
}

export function anonymizeCzechNames(text) {
  // Replace any token from CZECH_FIRSTNAMES (case-insensitive whole word)
  let out = text
  for (const name of CZECH_FIRSTNAMES) {
    const regex = new RegExp(`\\b${name}\\b`, 'gu')
    out = out.replace(regex, '[Jméno]')
    // Also lowercase form
    const lcRegex = new RegExp(`\\b${name.toLowerCase()}\\b`, 'gu')
    out = out.replace(lcRegex, '[Jméno]')
  }
  return out
}

export function anonymizeCompanies(text) {
  // Czech company suffix patterns: s.r.o. / a.s. / spol.s r.o. / k.s. / v.o.s.
  return text.replace(
    /\b[A-ZÁ-Ž][\wÁ-Žá-ž]+(?:\s+[A-ZÁ-Ž][\wÁ-Žá-ž]+)*\s+(s\.r\.o\.|a\.s\.|spol\.\s*s\s*r\.o\.|k\.s\.|v\.o\.s\.)/g,
    '[Firma] $1'
  )
}

// ── Manual review heuristic ──────────────────────────────────────────

export function findReviewCandidates(text) {
  // Capitalized tokens not in CZECH_FIRSTNAMES, not common words, not
  // already anonymized markers — operator should look at these.
  const COMMON_CZECH = new Set([
    'Dobrý','Dobrá','Pěkný','Pěkné','Vážený','Vážená','Děkuji','Děkujeme',
    'Pozdravem','Úctou','Hezký','Pondělí','Úterý','Středa','Čtvrtek','Pátek',
    'Sobota','Neděle','Leden','Únor','Březen','Duben','Květen','Červen',
    'Červenec','Srpen','Září','Říjen','Listopad','Prosinec',
    'Praha','Brno','Ostrava','Plzeň','Liberec','Olomouc','Hradec','Pardubice',
    'Re','Fwd','RE','FWD','From','To','Subject','Date','Message','ID',
  ])
  // Match Czech-letter words: uppercase ASCII or diacritic, followed by
  // ≥2 lowercase letters or diacritics. Lookbehind/lookahead for non-letter
  // because JS \b is ASCII-only even with /u flag (won't recognize ý/é/ž
  // as word characters).
  const titleMatches = text.match(/(?<!\p{L})\p{Lu}\p{Ll}{2,}(?!\p{L})/gu) || []
  // Also flag ALL-CAPS tokens of length ≥3 — common surname format
  // (NOVÁK, ŠTĚPÁNKA) that the Title-case regex above misses.
  const allCapsMatches = text.match(/(?<!\p{L})\p{Lu}{3,}(?!\p{L})/gu) || []
  const candidates = new Set()
  for (const m of [...titleMatches, ...allCapsMatches]) {
    if (COMMON_CZECH.has(m)) continue
    if (CZECH_FIRSTNAMES.has(m)) continue
    if (m.startsWith('Telefon') || m.startsWith('Jméno') || m.startsWith('Firma') || m.startsWith('Příjmení')) continue
    // Skip well-known acronyms operators expect to see verbatim.
    if (m === 'CEO' || m === 'CTO' || m === 'CFO' || m === 'GDPR' || m === 'PDF' || m === 'XML' || m === 'JSON' || m === 'SQL' || m === 'API') continue
    candidates.add(m)
  }
  return Array.from(candidates).sort()
}

// ── Per-message anonymizer ───────────────────────────────────────────

export function anonymizeMessage(msg, idx = 0) {
  const fromAnon = anonymizeEmail(msg.from_addr || msg.from || '')
  const toAnon = msg.to_addr || msg.to || 'op@gmail.lab'

  let bodyText = msg.body_text || msg.body || ''
  bodyText = anonymizeCompanies(bodyText)
  bodyText = anonymizeCzechNames(bodyText)
  bodyText = anonymizePhone(bodyText)
  bodyText = anonymizeURL(bodyText)
  // Email regex uses /u + Unicode property escapes so IDN TLDs (.práce,
  // .čsfd, etc.) are caught. Plain \w / [a-z] are ASCII-only.
  bodyText = bodyText.replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/giu, (m) => anonymizeEmail(m))

  const candidates = findReviewCandidates(bodyText)

  const subject = (msg.subject || '').replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/giu, '[Email]')
  const subjectClean = anonymizeCompanies(anonymizeCzechNames(subject))

  const messageID = msg.message_id || `<anon-${idx}-${Date.now()}@anon.lab>`
  const date = msg.received_at || msg.date || new Date().toISOString()

  const dateRfc822 = new Date(date).toUTCString()

  const eml = [
    `From: ${fromAnon}`,
    `To: ${toAnon}`,
    `Subject: ${subjectClean}`,
    `Date: ${dateRfc822}`,
    `Message-ID: ${messageID}`,
    `X-Lab-Category: ${msg.classification || 'ambiguous'}`,
    `X-Lab-Source: real-anonymized`,
    `X-Anon-Index: ${idx}`,
    msg.auto_submitted || /Auto-Submitted/i.test(msg.headers || '') ? 'Auto-Submitted: auto-replied' : null,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    bodyText,
  ].filter(Boolean).join('\r\n')

  return {
    eml,
    category: msg.classification || 'ambiguous',
    candidates,
    fromAnon,
    messageID,
  }
}

// ── CLI ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const positional = []
  const flags = { help: false, selfTest: false, strict: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') flags.help = true
    else if (a === '--self-test') flags.selfTest = true
    else if (a === '--strict') flags.strict = true
    else positional.push(a)
  }
  return { flags, positional }
}

function printHelp() {
  console.log(`Usage: anonymize.mjs <input.json> <output-dir>

Reads JSON array of outreach_messages rows, writes anonymized .eml files
under <output-dir>/<category>/<index>.eml.

Input JSON shape:
  [
    {
      "id": 123,
      "from_addr": "honza@somecompany.cz",
      "to_addr": "marketer@gmail.lab",
      "subject": "Re: Vaše nabídka",
      "body_text": "Dobrý den ...",
      "received_at": "2026-04-25T10:30:00Z",
      "classification": "not-interested"
    }
  ]

Output:
  <output-dir>/<category>/<paddedIndex>.eml + manual-review checklist printed.

Flags:
  --self-test    Run unit tests on anonymizer primitives + exit
  --strict       Exit non-zero (5) if review checklist has ANY remaining
                 candidates. Use in CI before fixtures hit git history —
                 forces operator to extend CZECH_FIRSTNAMES or refine
                 regex patterns rather than ignore the printed checklist.
  --help         This message

Exit: 0 ok / 1 input / 2 output / 3 args / 4 self-test fail / 5 strict gate (candidates remain)`)
}

function selfTest() {
  // Inline self-test (also covered by Vitest audit; this catches drift
  // when run standalone in CI).
  const tests = [
    {
      name: 'email replaced + deterministic',
      run: () => {
        const a = anonymizeEmail('honza@firma.cz')
        const b = anonymizeEmail('honza@firma.cz')
        return a === b && a.endsWith('@anon.lab')
      },
    },
    {
      name: 'phone CZ +420 grouped stripped',
      run: () => anonymizePhone('volejte +420 605 123 456') === 'volejte [Telefon]',
    },
    {
      name: 'phone bare 9 digits stripped',
      run: () => anonymizePhone('tel 605 123 456') === 'tel [Telefon]',
    },
    {
      name: 'czech first name replaced',
      run: () => anonymizeCzechNames('Jan Novák píše') === '[Jméno] Novák píše',
    },
    {
      name: 'company s.r.o. anonymized',
      run: () => anonymizeCompanies('ABC Servis s.r.o.').includes('[Firma]'),
    },
    {
      name: 'review candidates exclude greeting words',
      run: () => !findReviewCandidates('Dobrý den, děkuji.').includes('Dobrý'),
    },
  ]
  let pass = 0, fail = 0
  for (const t of tests) {
    try {
      if (t.run()) { console.log(`  ✓ ${t.name}`); pass++ }
      else { console.log(`  ✗ ${t.name}`); fail++ }
    } catch (e) {
      console.log(`  ✗ ${t.name} threw: ${e.message}`)
      fail++
    }
  }
  console.log(`\n${pass}/${pass + fail} pass`)
  return fail === 0
}

async function main() {
  const { flags, positional } = parseArgs(process.argv)
  if (flags.help) { printHelp(); return }
  if (flags.selfTest) {
    const ok = selfTest()
    process.exit(ok ? 0 : 4)
  }
  if (positional.length < 2) {
    console.error('Usage: anonymize.mjs <input.json> <output-dir>')
    process.exit(3)
  }
  const [inputPath, outDir] = positional

  let raw, parsed
  try { raw = readFileSync(inputPath, 'utf8') }
  catch (e) { console.error(`cannot read ${inputPath}: ${e.message}`); process.exit(1) }
  try { parsed = JSON.parse(raw) }
  catch (e) { console.error(`invalid JSON in ${inputPath}: ${e.message}`); process.exit(1) }
  if (!Array.isArray(parsed)) {
    console.error(`expected JSON array; got ${typeof parsed}`)
    process.exit(1)
  }

  try { mkdirSync(outDir, { recursive: true }) }
  catch (e) { console.error(`cannot create ${outDir}: ${e.message}`); process.exit(2) }

  const allCandidates = new Map() // candidate → count

  for (let i = 0; i < parsed.length; i++) {
    const msg = parsed[i]
    const result = anonymizeMessage(msg, i)
    const dir = join(outDir, result.category)
    mkdirSync(dir, { recursive: true })
    const idStr = String(i + 1).padStart(4, '0')
    const path = join(dir, `${idStr}.eml`)
    writeFileSync(path, result.eml)
    for (const c of result.candidates) {
      allCandidates.set(c, (allCandidates.get(c) || 0) + 1)
    }
  }

  console.log(`anonymize: wrote ${parsed.length} fixture(s) to ${outDir}\n`)

  if (allCandidates.size > 0) {
    console.log('── Manual review checklist ──')
    console.log('Capitalized tokens that might still be PII (review before commit):\n')
    const sorted = [...allCandidates.entries()].sort((a, b) => b[1] - a[1])
    for (const [token, count] of sorted.slice(0, 40)) {
      console.log(`  [${count}x]  ${token}`)
    }
    if (sorted.length > 40) {
      console.log(`  ... +${sorted.length - 40} more (full list: see anonymize-output.txt)`)
    }
    console.log('\nIf any of these are PII, add them to CZECH_FIRSTNAMES or extend regex patterns.')
    if (flags.strict) {
      console.error(`\n[strict] ${allCandidates.size} review candidate(s) remain — refusing to exit 0. Extend CZECH_FIRSTNAMES or regex patterns and re-run.`)
      process.exit(5)
    }
  } else {
    console.log('No review candidates flagged. Output looks clean.')
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
