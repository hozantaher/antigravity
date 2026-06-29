// widgetFormatters.js — AJ8 shared throughput-widget formatting helpers.
// ─────────────────────────────────────────────────────────────────────────────
// Extracted from LiveClusterRateWidget + VerifyQueueWidget + SendRateWidget +
// ActiveCampaignsLive + ReplyLatencyWidget where the same `cs-CZ`
// locale-number + percent + null-as-em-dash patterns were duplicated.
//
// These are pure, side-effect-free helpers — safe to unit-test without DOM.
//
// HARD RULE feedback_search_before_implement (T0): keep this module as the
// single source of truth for these formatters. New widget code should import
// from here rather than re-implementing inline `toLocaleString('cs-CZ')`.

/**
 * Render an integer-ish value using cs-CZ grouping. Returns `'—'` for
 * null / undefined / NaN so widget rows can render without conditionals.
 *
 * @param {number | string | null | undefined} n
 * @returns {string}
 */
export function formatNumber(n) {
  if (n == null || Number.isNaN(Number(n))) return '—'
  try {
    return Number(n).toLocaleString('cs-CZ')
  } catch {
    return String(n)
  }
}

/**
 * Render a percent value with a trailing `%`. Returns `'—'` for
 * null / undefined / NaN. The caller is responsible for already having
 * computed the number in 0..100 range — this helper does NOT multiply
 * by 100.
 *
 * @param {number | string | null | undefined} value
 * @returns {string}
 */
export function formatPercent(value) {
  if (value == null || Number.isNaN(Number(value))) return '—'
  return `${value} %`
}
