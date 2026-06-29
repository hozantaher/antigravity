// Placeholder-password detector. Conservative — false positives are cheaper
// than shipping a silent auth failure. Kept in sync with Go
// mailbox.IsPlaceholderPassword and BFF server.js isPlaceholderPassword.

export const MIN_REAL_PASSWORD_LEN = 8
export const KNOWN_BAD_PREFIXES = ['xxxx', 'password', 'admin', 'test', 'heslo', 'change-me']

/**
 * Returns true if the string appears to be a repeated-trigram sequence.
 * Used as an additional signal to catch patterns like "abcabcabcabcabcabcabc".
 *
 * @param {string} s
 * @param {number} minRepeats  – minimum consecutive repeats of the same 3-char window
 * @returns {boolean}
 */
export function hasRepeatedTrigram(s, minRepeats = 3) {
  if (typeof s !== 'string' || s.length < 3 * minRepeats) return false
  const counts = new Map()
  for (let i = 0; i + 3 <= s.length; i++) {
    const tri = s.slice(i, i + 3)
    const n = (counts.get(tri) || 0) + 1
    counts.set(tri, n)
    if (n >= minRepeats) return true
  }
  return false
}

/**
 * Returns true if `p` looks like a placeholder / default password that was
 * never updated by the user.
 *
 * Rules:
 *  - null / undefined / empty string → true  (missing)
 *  - non-string                       → true  (unexpected type)
 *  - shorter than MIN_REAL_PASSWORD_LEN chars → true
 *  - starts with a known bad prefix (case-insensitive) → true
 *  - contains ≥7 repeated trigrams → true  (e.g. "abcabcabcabcabcabcabc")
 *
 * @param {unknown} p
 * @returns {boolean}
 */
export function isPlaceholderPassword(p) {
  if (p == null || p === '') return true
  if (typeof p !== 'string') return true
  if (p.length < MIN_REAL_PASSWORD_LEN) return true
  const lower = p.toLowerCase()
  for (const prefix of KNOWN_BAD_PREFIXES) {
    if (lower.startsWith(prefix)) return true
  }
  if (hasRepeatedTrigram(p, 7)) return true
  return false
}
