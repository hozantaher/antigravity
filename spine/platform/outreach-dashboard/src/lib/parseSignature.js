// parseSignature.js — extract the structured contact block from a reply's
// signature (#1581 [M2.1]). Where mineReplySignals() scans the WHOLE body for
// any phone/price, this targets the signature tail specifically and associates
// the fields that identify WHO to call: company, IČO, email, phones.
//
// The IČO is the high-value field — it links the reply back to a known
// crm_clients row (the BFF does that lookup at read-time). The company + email
// give the operator the "ask for X at Y" context without scrolling the mail.
//
// Pure + deterministic (regex), runs AFTER stripQuotedReply so a quoted-back
// original signature (our own footer) doesn't get parsed as the seller's.
//
// Output: { hasSignature, salutation, company, ico, email, phones } | null.

import { stripQuotedReply } from './quoteStrip.js'
import { mineReplySignals } from './mineReplySignals.js'

const stripDiacritics = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '')

// Closing salutations that mark the start of a signature block (matched on a
// diacritic-stripped lowercase line). CZ business mail conventions.
const SALUTATION = /\b(s pozdravem|s pratelskym pozdravem|se srdecnym pozdravem|s uctou|preji (hezky|pekny|prijemny) den|hezky den|pekny den|mejte se( hezky)?|dekuji a preji|zdravim)\b/

// 8-digit Czech IČO. Labelled forms only (IČO/ICO/IC:) so we don't grab a
// random 8-digit number from the body.
const ICO = /\b(?:i[čc]o|ic)\s*:?\s*(\d{8})\b/i
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i
// Czech legal-form suffixes mark the company line.
const LEGAL = /(spol\.?\s*s\s*r\.?\s*o\.?|s\.?\s*r\.?\s*o\.?|a\.?\s*s\.?|v\.?\s*o\.?\s*s\.?|k\.?\s*s\.?|z\.?\s*s\.?|o\.?\s*p\.?\s*s\.?)\b/i

const SIGNATURE_TAIL_LINES = 8 // fallback region when no salutation is present

/**
 * @param {string|null|undefined} bodyText
 * @returns {{ hasSignature: boolean, salutation: string|null, company: string|null,
 *             ico: string|null, email: string|null, phones: Array<{display:string,tel:string}> } | null}
 */
export function parseSignature(bodyText) {
  if (!bodyText || typeof bodyText !== 'string') return null
  const body = stripQuotedReply(bodyText) || bodyText
  const lines = body.split('\n')

  // Locate the signature region. Prefer the line carrying a closing salutation;
  // the signature is everything from there to the end. Without a salutation,
  // fall back to the last N non-empty lines (a bare contact block).
  let startLine = -1
  for (let i = 0; i < lines.length; i++) {
    if (SALUTATION.test(stripDiacritics(lines[i]).toLowerCase())) { startLine = i; break }
  }
  let region
  let salutation = null
  if (startLine >= 0) {
    salutation = lines[startLine].trim()
    region = lines.slice(startLine).join('\n')
  } else {
    const nonEmpty = lines.filter((l) => l.trim() !== '')
    region = nonEmpty.slice(-SIGNATURE_TAIL_LINES).join('\n')
  }

  const icoM = region.match(ICO)
  const emailM = region.match(EMAIL)
  const phones = mineReplySignals(region).phones

  // Company: first region line carrying a legal-form suffix (trimmed, label
  // noise like a leading "Firma:" stripped).
  let company = null
  for (const raw of region.split('\n')) {
    const line = raw.trim()
    if (line && LEGAL.test(line) && line.length <= 120) {
      company = line.replace(/^[a-zěščřžýáíéúůñ ]{0,20}:\s*/i, '').trim()
      break
    }
  }

  const ico = icoM ? icoM[1] : null
  const email = emailM ? emailM[0] : null
  const hasSignature = Boolean(salutation || company || ico || email || phones.length)
  if (!hasSignature) return null
  return { hasSignature, salutation, company, ico, email, phones }
}
