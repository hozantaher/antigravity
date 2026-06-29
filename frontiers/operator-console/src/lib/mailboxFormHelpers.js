/**
 * Helpers for the Mailbox add/edit modal and the page-level health-check
 * consolidation. Extracted so the logic is unit-testable in isolation —
 * see tests/unit/lib/mailboxFormHelpers.test.js.
 *
 * Two helpers live here:
 *
 *   1. providerAutoFill(email) → { smtp_host, smtp_port, imap_host, imap_port } | null
 *      Returns sane SMTP/IMAP defaults for known Czech mailbox providers
 *      (Seznam, post.cz). Returns null for unknown/custom domains so the
 *      operator gets to fill them in manually. Used by MailboxModal when
 *      the email field changes — only fills BLANK fields, never overwrites
 *      operator-typed values.
 *
 *   2. runFullCheck(ids, { fetchFn, setLiveScores }) → Promise<Record<id, score>>
 *      Consolidates fetchHealth() + rowRecheck() from the page. Behavior:
 *        - ids.length === 0  → GET /api/mailboxes/health-summary (bulk)
 *        - ids.length === 1  → GET /api/mailboxes/:id/full-check?force=1
 *        - ids.length >= 2   → Promise.all over per-mailbox full-check
 *      Merges results into liveScores via the supplied setter. Returns the
 *      merged-in slice so callers can chain on the result.
 */

const PROVIDER_PRESETS = {
  'seznam.cz': {
    smtp_host: 'smtp.seznam.cz',
    smtp_port: 465,
    imap_host: 'imap.seznam.cz',
    imap_port: 993,
  },
  'post.cz': {
    smtp_host: 'smtp.post.cz',
    smtp_port: 465,
    imap_host: 'imap.post.cz',
    imap_port: 993,
  },
  'email.cz': {
    smtp_host: 'smtp.email.cz',
    smtp_port: 465,
    imap_host: 'imap.email.cz',
    imap_port: 993,
  },
}

/**
 * Look up SMTP/IMAP defaults for a known provider domain. Returns null for
 * unknown domains so the caller can decide whether to keep typed values.
 *
 * @param {string} email
 * @returns {{smtp_host: string, smtp_port: number, imap_host: string, imap_port: number} | null}
 */
export function providerAutoFill(email) {
  if (typeof email !== 'string') return null
  const at = email.indexOf('@')
  if (at < 0) return null
  const domain = email.slice(at + 1).trim().toLowerCase()
  if (!domain) return null
  return PROVIDER_PRESETS[domain] || null
}

/**
 * @param {number[]} ids — empty array = bulk health-summary fetch.
 * @param {object} deps
 * @param {(url: string, init?: object) => Promise<Response>} deps.fetchFn
 * @param {(updater: (prev: Record<string|number, object>) => Record<string|number, object>) => void} deps.setLiveScores
 * @returns {Promise<Record<string|number, {score: number, ok: boolean, critical: any[]}>>}
 */
export async function runFullCheck(ids, { fetchFn, setLiveScores }) {
  const merged = {}

  if (!Array.isArray(ids) || ids.length === 0) {
    // Bulk — health-summary returns the canonical shape for every mailbox.
    const r = await fetchFn('/api/mailboxes/health-summary')
    const data = await r.json()
    for (const m of (data.mailboxes ?? [])) {
      merged[m.id] = { score: m.score, ok: m.ok, critical: m.critical }
    }
  } else if (ids.length === 1) {
    const id = ids[0]
    const r = await fetchFn(`/api/mailboxes/${id}/full-check?force=1`)
    const data = await r.json()
    merged[id] = { score: data.score, ok: data.ok, critical: data.critical }
  } else {
    // 2+: fan out, but resolve independently — one failure shouldn't reject the rest.
    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          const r = await fetchFn(`/api/mailboxes/${id}/full-check?force=1`)
          const data = await r.json()
          return [id, { score: data.score, ok: data.ok, critical: data.critical }]
        } catch {
          return null
        }
      }),
    )
    for (const pair of results) {
      if (!pair) continue
      const [id, payload] = pair
      merged[id] = payload
    }
  }

  if (typeof setLiveScores === 'function') {
    setLiveScores((prev) => ({ ...prev, ...merged }))
  }
  return merged
}
