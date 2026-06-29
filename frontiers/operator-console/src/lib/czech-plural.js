// Czech pluralization helpers — single source of truth for count-based
// grammar across MissingPasswordBanner, AuthFailAlertBanner, and any future
// count-sensitive UI copy.
//
// Grammar rule (nominative case, for nouns like "schránka" feminine):
//   1           → nominative singular           "schránka"
//   2, 3, 4     → nominative plural             "schránky"
//   0, 5+       → genitive plural               "schránek"
// Exception window:
//   11, 12, 13, 14 → genitive plural (even though ends in 1-4)
//
// The same rule applies to Czech verbs in present tense agreement:
//   1           → "má"
//   everything else → "mají"
// (no tricky exception for 11-14 in verb agreement — it's a plural subject)

function isSingular(n) {
  return n === 1
}

function isPluralNominative(n) {
  if (n < 2) return false
  if (n > 4) return false
  // 11-14 exception window — integers inside the window use genitive
  return n >= 2 && n <= 4
}

/**
 * Return the correct word form for a Czech feminine noun by count.
 * @param {number} n - non-negative integer
 * @param {{singular: string, plural: string, genitive: string}} forms
 */
export function plural(n, forms) {
  const k = Math.abs(Math.trunc(n))
  if (isSingular(k)) return forms.singular
  if (isPluralNominative(k)) return forms.plural
  return forms.genitive
}

/**
 * Shorthand for the "schránka" word (feminine, used in mailbox banners).
 */
export function schranka(n) {
  return plural(n, {
    singular: 'schránka',
    plural: 'schránky',
    genitive: 'schránek',
  })
}

/**
 * Verb form for subject-verb agreement: 1 → "má", everything else → "mají".
 */
export function verbForm(n) {
  return n === 1 ? 'má' : 'mají'
}
