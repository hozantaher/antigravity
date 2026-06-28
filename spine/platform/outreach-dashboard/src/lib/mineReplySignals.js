// mineReplySignals.js — deterministic data-mining of an inbound reply body
// (#1578 [M1]). The body is stored raw; this pulls the high-value structured
// signals an operator acts on. First + most valuable: PHONE NUMBERS — the whole
// výkup business closes deals by phone (memory project_vehicle_auction_intake),
// and the seller's number is usually right in the signature/body.
//
// Pure + deterministic (regex), no LLM — cheap enough to compute on read. Runs
// AFTER stripQuotedReply so the quoted-back original outbound doesn't poison the
// mine (our own footer number would otherwise be "extracted" from every reply).
//
// Output shape: { phones: [{display, tel}], prices: [{amount, currency, raw}] }
// Extensible — location/urgency (M1.3/M1.4) slot in later without a shape break.

import { stripQuotedReply } from './quoteStrip.js'

// CZ numbers are 9 digits. We accept three confident shapes and normalise all
// to +420XXXXXXXXX:
//   1. explicit +420 / 00420 / 420 prefix + 9 digits (any spacing)
//   2. 9 digits grouped 3-3-3 by space/dot/dash (grouping ⇒ phone, not IČO)
//   3. bare 9 digits beginning 6 or 7 (CZ mobile) — high enough confidence
// IČO (8 digits) and random long numbers are NOT matched.
const PHONE_PATTERNS = [
  /(?:\+420|00420|420)[\s.\-/]?(\d{3})[\s.\-/]?(\d{3})[\s.\-/]?(\d{3})/g,
  /(?<![\d.])(\d{3})[\s.\-](\d{3})[\s.\-](\d{3})(?![\d.])/g,
  /(?<![\d.+])([67]\d{2})(\d{3})(\d{3})(?![\d.])/g,
]

// "1 250 000 Kč", "250000,-", "cena 80.000 CZK". Capture the numeric run that
// precedes a CZK marker; thousands separators may be space or dot.
const PRICE_PATTERN = /(\d[\d\s.]{2,}\d|\d{3,})\s?(?:kč|czk|,-)/gi

// Intent patterns run on a DIACRITIC-STRIPPED lowercase copy of the body, so
// "ozvěte" and "ozvete", "spěchá" and "specha" all match one ASCII pattern.
const stripDiacritics = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
// Callback intent — the seller wants a phone call (highest signal for a
// phone-closed výkup).
const CALLBACK_PATTERN = /\b(zavolej|zavola|ozvete se|ozvi se|zatelefon|spojte se|brnkne|brnknete|volejte|prozvon)/
// Urgency — time pressure worth bumping in the queue.
// No trailing \b on the main group — "co nejdriv" is a prefix of "nejdrive".
// Short standalone words (dnes/zitra) keep boundaries to avoid in-word hits.
const URGENCY_PATTERN = /(spech|co nejdriv|urgent|ihned|nalehav|rychle|do konce tydne|do patku|obratem)|\b(dnes|zitra)\b/

// Location gazetteer (#1578 M1.3) — fixed list, zero false positives. Logistics
// for svoz techniky needs a region hint. Matched on the diacritic-stripped body
// as whole words; { ascii → display } so the operator sees the proper name. We
// deliberately avoid free-text city/PSČ extraction (too noisy) — this is the
// 13 kraje + Praha + the largest cities, which are unambiguous place names.
const LOCATION_GAZETTEER = [
  ['praha', 'Praha'], ['brno', 'Brno'], ['ostrava', 'Ostrava'], ['plzen', 'Plzeň'],
  ['liberec', 'Liberec'], ['olomouc', 'Olomouc'], ['hradec kralove', 'Hradec Králové'],
  ['ceske budejovice', 'České Budějovice'], ['usti nad labem', 'Ústí nad Labem'],
  ['pardubice', 'Pardubice'], ['zlin', 'Zlín'], ['jihlava', 'Jihlava'],
  ['karlovy vary', 'Karlovy Vary'],
  ['stredocesky', 'Středočeský kraj'], ['jihocesky', 'Jihočeský kraj'],
  ['plzensky', 'Plzeňský kraj'], ['karlovarsky', 'Karlovarský kraj'],
  ['ustecky', 'Ústecký kraj'], ['liberecky', 'Liberecký kraj'],
  ['kralovehradecky', 'Královéhradecký kraj'], ['pardubicky', 'Pardubický kraj'],
  ['vysocina', 'Vysočina'], ['jihomoravsky', 'Jihomoravský kraj'],
  ['olomoucky', 'Olomoucký kraj'], ['zlinsky', 'Zlínský kraj'],
  ['moravskoslezsky', 'Moravskoslezský kraj'],
]

// Common Czech case endings (ASCII-folded — the body is diacritic-stripped
// before matching) that may follow a place-name stem. Used to anchor each
// gazetteer stem as `\b<stem><ending?>\b` so it matches whole declined forms
// (Brno/Brna/Brně/Brnem, Středočeského) but NOT a longer unrelated word that
// merely shares the prefix ("brn" must not fire on "brnknete"). Multi-char
// endings are listed first so the alternation prefers the longest match.
const CZ_CASE_ENDINGS =
  '(?:eho|emu|ich|ych|ymi|ami|ach|emi|ovi|ech|ou|em|im|ym|um|am|a|e|i|o|u|y)?'

function normalizePhone(d1, d2, d3) {
  const digits = `${d1}${d2}${d3}`
  if (digits.length !== 9) return null
  return { display: `+420 ${d1} ${d2} ${d3}`, tel: `+420${digits}` }
}

/**
 * Mine structured signals from a raw reply body.
 * @param {string|null|undefined} bodyText
 * @returns {{ phones: Array<{display:string,tel:string}>, prices: Array<{amount:number,currency:string,raw:string}>, callback: boolean, urgent: boolean, locations: string[] }}
 */
export function mineReplySignals(bodyText) {
  const empty = { phones: [], prices: [], callback: false, urgent: false, locations: [] }
  if (!bodyText || typeof bodyText !== 'string') return empty

  const body = stripQuotedReply(bodyText) || bodyText

  // ── Phones (dedup by normalised tel) ──────────────────────────────────────
  // Patterns run high-confidence → loose. After each pass we blank the matched
  // spans so a looser pattern can't re-grab leftover digits — e.g. the grouped
  // pattern must not read "420 775 040" out of an already-claimed
  // "+420 775 040 593".
  const seen = new Set()
  const phones = []
  let work = body
  for (const re of PHONE_PATTERNS) {
    re.lastIndex = 0
    let m
    const spans = []
    while ((m = re.exec(work)) !== null) {
      const p = normalizePhone(m[1], m[2], m[3])
      spans.push([m.index, m.index + m[0].length])
      if (p && !seen.has(p.tel)) { seen.add(p.tel); phones.push(p) }
    }
    for (const [s, e] of spans) work = work.slice(0, s) + ' '.repeat(e - s) + work.slice(e)
  }

  // ── Prices in CZK ─────────────────────────────────────────────────────────
  const prices = []
  const seenP = new Set()
  let pm
  PRICE_PATTERN.lastIndex = 0
  while ((pm = PRICE_PATTERN.exec(body)) !== null) {
    const amount = Number(pm[1].replace(/[\s.]/g, ''))
    if (Number.isFinite(amount) && amount >= 1000 && !seenP.has(amount)) {
      seenP.add(amount)
      prices.push({ amount, currency: 'CZK', raw: pm[0].trim() })
    }
  }

  // ── Intent flags (callback / urgency) ─────────────────────────────────────
  const ascii = stripDiacritics(body).toLowerCase()
  const callback = CALLBACK_PATTERN.test(ascii)
  const urgent = URGENCY_PATTERN.test(ascii)

  // ── Locations (fixed gazetteer; stem + declension suffix for CZ cases) ─────
  // Czech inflects place names (Ostrava → Ostravě), so we match a stem with the
  // trailing vowels stripped, followed by an OPTIONAL Czech case ending and a
  // CLOSING word boundary. A bare-prefix match (\b<stem>) was a false-positive
  // trap: "brno" → stem "brn" → /\bbrn/ matched "brnknete"/"brnkne" ("call me",
  // a CALLBACK signal) and emitted a phantom "Brno". Anchoring with an ending +
  // \b means only whole declined forms match (brno/brna/brně/brnem), never a
  // longer unrelated word that merely starts with the stem. Body is ASCII-folded
  // (ě→e, á→a …) so the endings are spelled without diacritics.
  const locations = []
  for (const [term, display] of LOCATION_GAZETTEER) {
    const stem = term.replace(/ /g, '\\s+').replace(/[aeiouy]+$/, '')
    const re = new RegExp(`\\b${stem}${CZ_CASE_ENDINGS}\\b`)
    if (re.test(ascii) && !locations.includes(display)) locations.push(display)
  }

  return { phones, prices, callback, urgent, locations }
}
