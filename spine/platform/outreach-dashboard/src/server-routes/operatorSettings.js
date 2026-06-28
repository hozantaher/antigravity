// operatorSettings.js — BFF routes for operator_settings CRUD.
// ─────────────────────────────────────────────────────────────────────────────
// Sprint AF: operator-config extraction.
// Sprint AH1: extended allowlist + per-key type validation (thresholds panel).
//
// Routes:
//   GET  /api/operator-settings          — returns all key/value pairs with metadata
//   PUT  /api/operator-settings/:key     — updates one key; requires X-Confirm-Send header
//                                          writes audit row to operator_audit_log
//
// Security gate: PUT requires header X-Confirm-Send: yes to prevent accidental
// browser-initiated mutations (same pattern as bulk send gate).
//
// Allowlist: branding keys (Sprint AF) + verify-loop config (H3) + bounce/spam
// thresholds + toggles + caps (AH1). Unknown keys return 404.
//
// Type validation (AH1): keys that exist in `SPEC_BY_KEY` (thresholdDefaults)
// are validated as float/int/boolean with min/max bounds; branding keys remain
// free-form strings (legacy behaviour).

import { SPEC_BY_KEY, validateValue } from '../lib/thresholdDefaults.js'

/**
 * Validate a candidate value for a thresholds key. Returns null on success
 * or an error message. Returns null also for keys NOT in the thresholds
 * spec (those are branding/legacy free-form strings).
 *
 * @param {string} key
 * @param {string} trimmed
 * @returns {string|null}
 */
function validateThresholdValue(key, trimmed) {
  if (!SPEC_BY_KEY[key]) return null
  return validateValue(key, trimmed)
}

const ALLOWED_KEYS = new Set([
  // Sprint AF — branding / GDPR controller entity (9 keys).
  'controller_name',
  'controller_id_label',
  'controller_id_value',
  'controller_seat_address',
  'controller_legal_basis_citation',
  'unsubscribe_base_url',
  'privacy_contact_email',
  'data_source_label',
  'brand_label',
  'lia_nace_scope',          // Sprint AI: JSON array of 2-digit NACE section codes
  // Sprint H3 — verify loop config.
  'email_verify_daily_max',  // verify loop daily budget
  'email_verify_batch_size', // verify loop batch size per tick
  'verify_loop_enabled',     // feature flag (replaces VERIFY_LOOP_CONTACTS_ENABLED env)
  'verify_loop_paused',      // operator pause flag (DB-backed; replaces in-memory only)
  // Sprint AH1 — bounce/spam thresholds + distribution + toggles + caps.
  // Defaults + metadata live in src/lib/thresholdDefaults.js; this allowlist
  // mirrors that flat key list (single source of truth at module-load time).
  'bounce_rate_critical_threshold',
  'bounce_rate_pause_threshold',
  'bounce_rate_throttle_threshold',
  'bounce_rate_1h_per_mailbox_threshold',
  'bounce_rate_1h_cluster_threshold',
  'bounce_rate_1h_dedup_window_minutes',
  'consecutive_bounces_pause_threshold',
  'distribution_imbalance_threshold',
  'mailbox_min_volume_for_rate_check',
  'corporate_domain_lifetime_cap_enabled',
  'reply_pre_classification_enabled',
  'verify_queue_tier_priority_enabled',
  'corporate_domain_max_per_campaign',
  // Sprint iter57 — keys present in thresholdDefaults.js + THRESHOLD_GROUPS
  // but previously missing from ALLOWED_KEYS → PUT returned 404 on Save.
  'auth_fail_pause_threshold',
  'spam_complaint_pause_threshold',
  'imap_inbox_audit_gap_threshold',
  'imap_inbox_audit_enabled',
  'presend_smtp_probe_high_risk_domains',
  // iter57 Win 4 — DB fallback for MAILBOX_MIN_SPACING_SECONDS env var.
  // operatorMetrics.resolveSpacingSeconds already reads this key; adding
  // to allowlist enables the Thresholds UI row to save.
  'mailbox_min_spacing_seconds_default',
])

/**
 * Mount operator-settings routes on the Express app.
 *
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   capture500: (res: import('express').Response, err: unknown, safeError: (e: unknown) => string) => void,
 *   safeError: (e: unknown) => string,
 * }} deps
 */
export function mountOperatorSettingsRoutes(app, { pool, capture500, safeError }) {
  // GET /api/operator-settings — list all key/value pairs with metadata.
  app.get('/api/operator-settings', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT key, value, updated_at, updated_by
         FROM operator_settings
         ORDER BY key ASC`
      )
      res.json(rows)
    } catch (e) { capture500(res, e, safeError) }
  })

  // PUT /api/operator-settings/:key — update one key.
  // Requires X-Confirm-Send: yes to prevent accidental mutations.
  app.put('/api/operator-settings/:key', async (req, res) => {
    const { key } = req.params
    const confirm = req.headers['x-confirm-send']

    // Security gate.
    if (confirm !== 'yes') {
      return res.status(400).json({
        error: 'Missing or invalid X-Confirm-Send header (must be "yes")',
      })
    }

    // Allowlist check — unknown keys are not writable via this API.
    if (!ALLOWED_KEYS.has(key)) {
      return res.status(404).json({ error: `Unknown operator-settings key: ${key}` })
    }

    const { value } = req.body
    if (typeof value !== 'string' || value.trim() === '') {
      return res.status(400).json({ error: 'value must be a non-empty string' })
    }

    // Sprint AH1 — type validation for the thresholds allowlist subset.
    // Branding keys remain free-form strings (legacy behaviour preserved).
    const trimmed = value.trim()
    const typeErr = validateThresholdValue(key, trimmed)
    if (typeErr) {
      return res.status(400).json({ error: typeErr })
    }

    const actor = req.headers['x-actor'] || 'dashboard'

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      const { rows } = await client.query(
        `INSERT INTO operator_settings (key, value, updated_at, updated_by)
         VALUES ($1, $2, NOW(), $3)
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value,
               updated_at = EXCLUDED.updated_at,
               updated_by = EXCLUDED.updated_by
         RETURNING key, value, updated_at, updated_by`,
        [key, value.trim(), actor]
      )

      // entity_id is bigint — operator_settings keys are strings, so pass NULL
      // and encode the key in the details JSON (already present there).
      await client.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ($1, $2, $3, NULL, $4)`,
        [
          'operator_settings_update',
          actor,
          'operator_settings',
          JSON.stringify({ key, new_value: value.trim() }),
        ]
      )

      await client.query('COMMIT')
      res.json(rows[0])
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      capture500(res, e, safeError)
    } finally {
      client.release()
    }
  })
}
