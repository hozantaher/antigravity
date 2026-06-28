// highRiskDomains.js — Sprint AE2 (2026-05-14)
// ─────────────────────────────────────────────────────────────────────────────
// Operator-facing CRUD for `operator_settings.presend_smtp_probe_high_risk_domains`,
// the comma-separated lowercase domain list that gates the level-2 RCPT-TO
// probe in the X7 pre-send gate (PR #1379, services/campaigns/sender/x7).
//
// Routes:
//   GET  /api/operator-settings/high-risk-domains
//        → { domains: string[], active_probe_count_24h: number, updated_at, updated_by }
//   PUT  /api/operator-settings/high-risk-domains
//        body { domains: string[] }
//        → { domains: string[], updated_at, updated_by }
//
// Security: state-changing PUT requires `X-Confirm-Send: yes` header (same
// pattern as the broader `/api/operator-settings/:key` endpoint).
//
// HARD RULES respected:
//   - feedback_no_magic_thresholds (T0): MAX_DOMAINS + DOMAIN_REGEX named.
//   - feedback_audit_log_on_mutations (T0): every PUT writes one
//     `operator_audit_log` row in the same tx as the UPDATE.
//   - feedback_schema_verify_before_sql (T0): operator_settings + audit_log
//     columns verified via `psql \d` 2026-05-14 (see PR description).
//
// Schema referenced (PROD-verified 2026-05-14):
//   operator_settings(key TEXT PK, value TEXT, updated_at TIMESTAMPTZ,
//                     updated_by TEXT, description TEXT)
//   operator_audit_log(id BIGINT PK, action TEXT, actor TEXT,
//                      created_at TIMESTAMPTZ, details JSONB,
//                      entity_id BIGINT, entity_type TEXT)

// Setting key used in `operator_settings.key`. Centralized here to avoid the
// "stringly typed key drift" pattern (multiple files spell-check this one).
export const SETTING_KEY = 'presend_smtp_probe_high_risk_domains'

// Audit action emitted on every successful PUT. Used by /api/audit/recent
// consumers + report tooling if/when they want to surface a history view.
export const AUDIT_ACTION = 'high_risk_domains_update'

// Max number of domains in a single list. Hard cap because:
//   1. `operator_settings.value` is TEXT but BFF/UI doesn't paginate.
//   2. The level-2 probe in X7 short-circuits at first match; a longer list
//      is a code smell — operator should investigate root cause instead.
//   3. 50 × ~30 char domain ≈ 1.5 KB serialized — well inside reason for a
//      single setting row.
export const MAX_DOMAINS = 50

// Hostname validation. Single-label domains (`localhost`) are disallowed —
// we want at least one dot + a 2+ char TLD. Lowercase enforced because
// the X7 gate matches case-sensitively against contact email-domain.
// Examples accepted: tiscali.cz, post.email.cz, mb-123.example.co.uk
// Examples rejected: TISCALI.CZ, foo, .com, foo..bar, foo.c
export const DOMAIN_REGEX = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/

// 24-hour window for the active-probe counter (informational only — operator
// is told how many times the level-2 probe activated since they last looked).
const PROBE_COUNT_WINDOW_HOURS = 24

// Audit-log action emitted by the SENDER service whenever the level-2 RCPT
// probe fires. Used in the 24h counter SELECT. The sender writes this action
// when X7 skips a contact via the level-2 path; absent from audit log if no
// activations happened yet (counter falls back to 0).
const PROBE_ACTION = 'presend_rcpt_probe_skip'

/**
 * Parse the comma-separated stored value into a deduped, lowercase domain
 * array. Empty / whitespace-only entries are filtered out. Order is
 * preserved (operators sometimes encode "highest-risk first" semantics).
 *
 * @param {string | null | undefined} raw
 * @returns {string[]}
 */
export function parseStoredDomains(raw) {
  if (!raw || typeof raw !== 'string') return []
  const seen = new Set()
  const out = []
  for (const part of raw.split(',')) {
    const d = part.trim().toLowerCase()
    if (!d) continue
    if (seen.has(d)) continue
    seen.add(d)
    out.push(d)
  }
  return out
}

/**
 * Serialize a domain array into the canonical comma-separated string for
 * persistence in operator_settings.value.
 *
 * @param {string[]} domains
 * @returns {string}
 */
export function serializeDomains(domains) {
  return domains.join(',')
}

/**
 * Validate + normalize a candidate list from the operator. Returns either
 * `{ ok: true, domains }` (normalized + deduped) or `{ ok: false, error,
 * code }` with a HTTP-friendly 400 error message.
 *
 * Rules (enforced in order, short-circuit on first failure):
 *   1. Input must be an array.
 *   2. Each entry must be a non-empty string after trim().
 *   3. Length <= MAX_DOMAINS (after dedup; over-cap input rejected).
 *   4. Each lowercase-trimmed entry must match DOMAIN_REGEX.
 *
 * Dedup is case-insensitive (Foo.Cz + foo.cz collapse to one).
 *
 * @param {unknown} input
 * @returns {{ ok: true, domains: string[] } | { ok: false, error: string, code: string }}
 */
export function validateDomainList(input) {
  if (!Array.isArray(input)) {
    return { ok: false, error: 'domains must be an array', code: 'not_array' }
  }

  const seen = new Set()
  const normalized = []
  for (let i = 0; i < input.length; i++) {
    const entry = input[i]
    if (typeof entry !== 'string') {
      return {
        ok: false,
        error: `domains[${i}] must be a string (got ${typeof entry})`,
        code: 'wrong_type',
      }
    }
    const d = entry.trim().toLowerCase()
    if (d === '') continue // Skip blanks — operator may submit trailing comma.
    if (!DOMAIN_REGEX.test(d)) {
      return {
        ok: false,
        error: `domains[${i}] is not a valid domain: ${entry.slice(0, 64)}`,
        code: 'invalid_format',
      }
    }
    if (seen.has(d)) continue // Case-insensitive dedup.
    seen.add(d)
    normalized.push(d)
  }

  if (normalized.length > MAX_DOMAINS) {
    return {
      ok: false,
      error: `domains list too long: ${normalized.length} > ${MAX_DOMAINS}`,
      code: 'too_many',
    }
  }

  return { ok: true, domains: normalized }
}

/**
 * Mount the high-risk-domains routes on the Express app.
 *
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   capture500?: (res: import('express').Response, err: unknown, safeError?: Function) => void,
 *   safeError?: (e: unknown) => string,
 * }} deps
 */
export function mountHighRiskDomainsRoutes(app, { pool, capture500, safeError } = {}) {
  // Fallback error helpers so the route works standalone in unit tests where
  // capture500 isn't injected.
  const fallbackSafeError = safeError || ((e) => (e && e.message ? String(e.message) : 'internal'))
  const fallbackCapture500 = capture500 || ((res, err) => {
    res.status(500).json({ ok: false, error: fallbackSafeError(err) })
  })

  // ── GET /api/operator-settings/high-risk-domains ──────────────────────
  app.get('/api/operator-settings/high-risk-domains', async (_req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT value, updated_at, updated_by
         FROM operator_settings
         WHERE key = $1
         LIMIT 1`,
        [SETTING_KEY]
      )
      const row = rows[0] || { value: '', updated_at: null, updated_by: null }
      const domains = parseStoredDomains(row.value)

      // Best-effort 24h probe count. If operator_audit_log doesn't have the
      // action yet (or DB unreachable), fall back to 0 — the panel is still
      // useful for editing the list even when the counter is missing.
      let activeProbeCount24h = 0
      try {
        const { rows: cntRows } = await pool.query(
          `SELECT COUNT(*)::bigint AS n
           FROM operator_audit_log
           WHERE action = $1
             AND created_at > NOW() - ($2::text || ' hours')::interval`,
          [PROBE_ACTION, String(PROBE_COUNT_WINDOW_HOURS)]
        )
        activeProbeCount24h = Number(cntRows[0]?.n || 0)
      } catch {
        // Counter is informational; never fail the whole GET on it.
        activeProbeCount24h = 0
      }

      res.json({
        domains,
        active_probe_count_24h: activeProbeCount24h,
        updated_at: row.updated_at,
        updated_by: row.updated_by,
        max_domains: MAX_DOMAINS,
        window_hours: PROBE_COUNT_WINDOW_HOURS,
      })
    } catch (e) {
      fallbackCapture500(res, e, fallbackSafeError)
    }
  })

  // ── PUT /api/operator-settings/high-risk-domains ──────────────────────
  app.put('/api/operator-settings/high-risk-domains', async (req, res) => {
    // Security gate — same convention as /api/operator-settings/:key.
    const confirm = req.headers['x-confirm-send']
    if (confirm !== 'yes') {
      return res.status(400).json({
        ok: false,
        error: 'Missing or invalid X-Confirm-Send header (must be "yes")',
        code: 'confirm_required',
      })
    }

    const body = req.body || {}
    const v = validateDomainList(body.domains)
    if (!v.ok) {
      return res.status(400).json({ ok: false, error: v.error, code: v.code })
    }

    const newValue = serializeDomains(v.domains)
    const actor = String(req.headers['x-actor'] || 'dashboard').slice(0, 128)

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // Read the prior value (for audit details) within the tx so the
      // before/after pair is atomic against concurrent writes.
      const { rows: prev } = await client.query(
        `SELECT value FROM operator_settings WHERE key = $1 FOR UPDATE`,
        [SETTING_KEY]
      )
      const oldValue = prev[0]?.value ?? null
      const oldDomains = parseStoredDomains(oldValue)

      const { rows: upserted } = await client.query(
        `INSERT INTO operator_settings (key, value, updated_at, updated_by)
         VALUES ($1, $2, NOW(), $3)
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value,
               updated_at = EXCLUDED.updated_at,
               updated_by = EXCLUDED.updated_by
         RETURNING key, value, updated_at, updated_by`,
        [SETTING_KEY, newValue, actor]
      )

      await client.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ($1, $2, $3, NULL, $4)`,
        [
          AUDIT_ACTION,
          actor,
          'operator_settings',
          JSON.stringify({
            key: SETTING_KEY,
            old_value: oldValue,
            new_value: newValue,
            old_count: oldDomains.length,
            new_count: v.domains.length,
          }),
        ]
      )

      await client.query('COMMIT')

      const row = upserted[0]
      res.json({
        domains: v.domains,
        updated_at: row.updated_at,
        updated_by: row.updated_by,
      })
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      fallbackCapture500(res, e, fallbackSafeError)
    } finally {
      client.release()
    }
  })
}
