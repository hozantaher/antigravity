// Canonical HMAC unsubscribe-token helpers (JS twin of services/common/token).
//
// Format MUST stay byte-identical to the Go side
// (services/common/token/unsub.go) — the runner emits the token at send
// time and the BFF /unsubscribe handler recomputes it on click. Both
// layers fail closed if formats diverge, so any drift here breaks every
// outstanding link.
//
// Locked formula:
//   HMAC-SHA256(secret, `${campaignID}|${contactID}|${email}`)
//     → toString('hex').slice(0, 16)   // 16 hex chars = 64 bits
//
// 64 bits is sufficient for an opt-out gate. Attacker would need 2^64
// guesses to forge a single token, and the only damage on success is
// opting someone OUT — benign.
//
// Constant-time compare via crypto.timingSafeEqual prevents per-byte
// timing leaks; a naive `===` over hex strings short-circuits and could
// be brute-forced one nibble at a time over many requests.

import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Build the 16-hex-char HMAC-SHA256 unsubscribe token bound to a recipient.
 *
 * @param {number|string} campaignID - integer-coercible campaign id
 * @param {number|string} contactID - integer-coercible contact id
 * @param {string} email - recipient email (case as stored)
 * @param {string|Buffer} secret - HMAC key (UNSUBSCRIBE_SECRET or fallback)
 * @returns {string} lowercase hex token, exactly 16 characters
 */
export function buildUnsubToken(campaignID, contactID, email, secret) {
  return createHmac('sha256', secret)
    .update(`${campaignID}|${contactID}|${email}`)
    .digest('hex')
    .slice(0, 16)
}

/**
 * Constant-time-compare a received token against the expected HMAC for
 * (campaignID, contactID, email). Returns false on any tamper, length
 * mismatch, or wrong secret.
 *
 * @param {number|string} campaignID
 * @param {number|string} contactID
 * @param {string} email
 * @param {string} received - token from the URL ?t= param
 * @param {string|Buffer} secret
 * @returns {boolean}
 */
export function verifyUnsubToken(campaignID, contactID, email, received, secret) {
  // Validate the FORMAT first: exactly 16 lowercase hex chars (see
  // buildUnsubToken). A naive string-length guard is unsafe because a 16
  // code-unit multibyte string passes `length === 16` yet Buffer.from() yields
  // a different BYTE length, making crypto.timingSafeEqual throw RangeError on
  // unequal buffers. A format-valid token is exactly 16 bytes, matching the
  // (always 16-hex-char) expected token, so the constant-time compare is safe.
  if (typeof received !== 'string' || !/^[0-9a-f]{16}$/.test(received)) return false
  const expected = buildUnsubToken(campaignID, contactID, email, secret)
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(received, 'utf8'))
}
