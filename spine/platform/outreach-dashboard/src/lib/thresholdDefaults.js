// thresholdDefaults.js — Sprint AH1.
// ─────────────────────────────────────────────────────────────────────────────
// Canonical defaults + metadata for the 18 operator_settings keys exposed
// in /settings/thresholds.
//
// Per HARD RULE `feedback_no_magic_thresholds` (T0): every threshold lives
// in operator_settings or a named constant — never a literal inside JSX.
// This file IS the named-constant source; the JSX page reads from here.
//
// Per HARD RULE `feedback_env_var_needs_db_fallback` (T0): defaults below
// are last-resort fallbacks for when the operator_settings row is absent.
// The authoritative value at run-time is whatever the DB returns; operators
// tune via the UI; this file only seeds the UI when the DB is empty.

/**
 * @typedef {('float'|'int'|'boolean')} ThresholdType
 */

/**
 * @typedef {Object} ThresholdSpec
 * @property {string} key            DB key in operator_settings
 * @property {string} label          Czech label rendered in the UI
 * @property {string} desc           Short description / context for the operator
 * @property {ThresholdType} type    Validation + render hint
 * @property {string|number|boolean} defaultValue  Fallback when DB row missing
 * @property {number} [min]          Inclusive lower bound (numeric types only)
 * @property {number} [max]          Inclusive upper bound (numeric types only)
 * @property {string} [unit]         Display unit (e.g. '%', 'min', 'count')
 */

/**
 * @typedef {Object} ThresholdGroup
 * @property {string} key
 * @property {string} label
 * @property {string} desc
 * @property {ThresholdSpec[]} items
 */

/** @type {ThresholdSpec[]} */
const BOUNCE_SPAM = [
  {
    key: 'bounce_rate_critical_threshold',
    label: 'Bounce rate — kritický práh',
    desc: 'Při překročení se schránka označí jako critical (full-check tag).',
    type: 'float',
    defaultValue: 0.05,
    min: 0,
    max: 1,
    unit: 'podíl',
  },
  {
    key: 'bounce_rate_pause_threshold',
    label: 'Bounce rate — automatická pauza',
    desc: 'Schránka při překročení tohoto podílu hard-bounces přejde do paused.',
    type: 'float',
    defaultValue: 0.10,
    min: 0,
    max: 1,
    unit: 'podíl',
  },
  {
    key: 'bounce_rate_throttle_threshold',
    label: 'Bounce rate — throttle',
    desc: 'Pod tímto prahem se sníží daily cap, ale schránka ještě nepauzuje.',
    type: 'float',
    defaultValue: 0.05,
    min: 0,
    max: 1,
    unit: 'podíl',
  },
  {
    key: 'bounce_rate_1h_per_mailbox_threshold',
    label: 'Bounce rate 1h — per schránka',
    desc: 'Klouzavé okno 1h pro per-mailbox alert (sentry warning).',
    type: 'float',
    defaultValue: 0.01,
    min: 0,
    max: 1,
    unit: 'podíl',
  },
  {
    key: 'bounce_rate_1h_cluster_threshold',
    label: 'Bounce rate 1h — cluster',
    desc: 'Klouzavé okno 1h pro celý cluster odesílatelů (multi-mailbox alert).',
    type: 'float',
    defaultValue: 0.015,
    min: 0,
    max: 1,
    unit: 'podíl',
  },
  {
    key: 'bounce_rate_1h_dedup_window_minutes',
    label: 'Bounce rate 1h — dedup okno',
    desc: 'Po kolika minutách se může stejný alert znovu vystřelit.',
    type: 'int',
    defaultValue: 30,
    min: 1,
    max: 1440,
    unit: 'min',
  },
  {
    key: 'consecutive_bounces_pause_threshold',
    label: 'Po sobě jdoucí bounces — pauza',
    desc: 'N po sobě jdoucích hard-bounces u schránky → automatická pauza.',
    type: 'int',
    defaultValue: 5,
    min: 1,
    max: 100,
    unit: 'count',
  },
  {
    key: 'auth_fail_pause_threshold',
    label: 'Auth-fail — pauza',
    desc: 'N po sobě jdoucích SMTP/IMAP auth selhání → schránka přejde do auth_locked.',
    type: 'int',
    defaultValue: 3,
    min: 1,
    max: 20,
    unit: 'count',
  },
  {
    key: 'spam_complaint_pause_threshold',
    label: 'Spam complaint — pauza',
    desc: 'Podíl spam-complaints, při kterém se schránka pozastaví (FBL signal).',
    type: 'float',
    defaultValue: 0.001,
    min: 0,
    max: 1,
    unit: 'podíl',
  },
]

/** @type {ThresholdSpec[]} */
const DISTRIBUTION_CAPACITY = [
  {
    // DB fallback for MAILBOX_MIN_SPACING_SECONDS env var (iter57 E1).
    // operatorMetrics.resolveSpacingSeconds reads this key first, then env,
    // then hard default 180s. Adding here wires it into the Thresholds UI
    // so the operator can tune without an env edit + BFF restart.
    key: 'mailbox_min_spacing_seconds_default',
    label: 'Rozestup odesílání — min. sekund (per schránka)',
    desc: 'Minimální prodleva mezi dvěma po sobě jdoucími odesíláními ze stejné schránky. DB hodnota má přednost před env MAILBOX_MIN_SPACING_SECONDS.',
    type: 'int',
    defaultValue: 180,
    min: 1,
    max: 3600,
    unit: 's',
  },
  {
    key: 'distribution_imbalance_threshold',
    label: 'Nerovnoměrnost rozesílky',
    desc: 'Jak moc se může relativní podíl odeslaných emailů mezi schránkami lišit, než se vystřelí alert.',
    type: 'float',
    defaultValue: 0.5,
    min: 0,
    max: 1,
    unit: 'podíl',
  },
  {
    key: 'mailbox_min_volume_for_rate_check',
    label: 'Min. objem pro rate-check',
    desc: 'Pod tímto počtem odeslaných emailů se bounce-rate alarmy nevyhodnocují.',
    type: 'int',
    defaultValue: 10,
    min: 1,
    max: 10000,
    unit: 'count',
  },
  {
    key: 'email_verify_batch_size',
    label: 'Verify loop — batch size',
    desc: 'Kolik kontaktů se ověří v jednom ticku verify loopu.',
    type: 'int',
    defaultValue: 200,
    min: 1,
    max: 10000,
    unit: 'count',
  },
  {
    key: 'email_verify_daily_max',
    label: 'Verify loop — denní limit',
    desc: 'Maximální počet verify operací za den (anti-rate-limit pojistka).',
    type: 'int',
    defaultValue: 1000,
    min: 1,
    max: 1000000,
    unit: 'count',
  },
  {
    // 2026-05-18 hardening — runImapInboxAuditCron compares IMAP UNSEEN
    // to ingested reply_inbox rows per mailbox and emits an alert when
    // the gap exceeds this threshold. Captures silent INSERT failures
    // (notify_reply trigger bug, parser bug, etc.) that historically
    // only surfaced via manual investigation.
    key: 'imap_inbox_audit_gap_threshold',
    label: 'IMAP inbox audit — gap threshold',
    desc: 'O kolik zpráv smí IMAP UNSEEN převýšit počet ingestovaných řádků za 24h, než se vystřelí alert (per schránka).',
    type: 'int',
    defaultValue: 10,
    min: 1,
    max: 1000,
    unit: 'count',
  },
]

/** @type {ThresholdSpec[]} */
const PRESEND_GUARDS = [
  {
    key: 'presend_smtp_probe_high_risk_domains',
    label: 'Pre-send probe — rizikové domény (CSV)',
    desc: 'Domény, na které pre-send level-2 RCPT probe vždy běží (čárkou oddělené, např. "tiscali.cz, gawab.com"). Suppression checkne i bez probe.',
    type: 'string',
    defaultValue: 'tiscali.cz',
  },
]

/** @type {ThresholdSpec[]} */
const TOGGLES = [
  {
    key: 'corporate_domain_lifetime_cap_enabled',
    label: 'Corporate domain lifetime cap',
    desc: 'Globální vypínač pro pravidlo „max N kontaktů z jedné firemní domény za celou existenci kampaní".',
    type: 'boolean',
    defaultValue: true,
  },
  {
    key: 'reply_pre_classification_enabled',
    label: 'Reply pre-classification',
    desc: 'Pre-classify replies v IMAP poll loopu (negative/positive/neutral) přes Haiku klasifikátor.',
    type: 'boolean',
    defaultValue: true,
  },
  {
    key: 'verify_loop_enabled',
    label: 'Verify loop — aktivní',
    desc: 'Master switch pro verify-email cron. Off = žádné nové verify operace.',
    type: 'boolean',
    defaultValue: true,
  },
  {
    key: 'verify_queue_tier_priority_enabled',
    label: 'Verify queue — tier priority',
    desc: 'Když ON, verify queue prioritizuje high-tier kontakty nad low-tier.',
    type: 'boolean',
    defaultValue: true,
  },
  {
    // 2026-05-18 hardening — master switch for runImapInboxAuditCron.
    // Disable when on-call wants to silence the alert stream during a
    // known-broken-poller window (e.g. during a Z3 cutover).
    key: 'imap_inbox_audit_enabled',
    label: 'IMAP inbox audit — aktivní',
    desc: 'Master přepínač pro runImapInboxAuditCron (detekce mezery mezi IMAP UNSEEN a ingestovanými řádky).',
    type: 'boolean',
    defaultValue: true,
  },
]

/** @type {ThresholdSpec[]} */
const CAPS = [
  {
    key: 'corporate_domain_max_per_campaign',
    label: 'Corporate domain — max per kampaň',
    desc: 'Maximum kontaktů z jedné firemní domény, které se enrollnou do jedné kampaně.',
    type: 'int',
    defaultValue: 1,
    min: 1,
    max: 100,
    unit: 'count',
  },
]

/** @type {ThresholdGroup[]} */
export const THRESHOLD_GROUPS = [
  {
    key: 'bounce_spam',
    label: 'Bounce / Spam thresholds',
    desc: 'Prahy pro bounce-rate alerts, throttle, a auto-pauzu schránek.',
    items: BOUNCE_SPAM,
  },
  {
    key: 'distribution_capacity',
    label: 'Distribution / Capacity',
    desc: 'Limity pro objem, verify queue a rovnoměrnost rozesílky.',
    items: DISTRIBUTION_CAPACITY,
  },
  {
    key: 'toggles',
    label: 'Toggles',
    desc: 'Boolean přepínače pro feature flags.',
    items: TOGGLES,
  },
  {
    key: 'caps',
    label: 'Caps',
    desc: 'Per-kampaň/per-doména limity.',
    items: CAPS,
  },
  {
    key: 'presend_guards',
    label: 'Pre-send guardy',
    desc: 'Pravidla pre-send checků (RCPT probe, high-risk doménová whitelista).',
    items: PRESEND_GUARDS,
  },
]

/** Flat lookup of all writable keys (used by BFF allowlist + UI). */
export const ALL_THRESHOLD_KEYS = THRESHOLD_GROUPS.flatMap(g => g.items.map(i => i.key))

/** Quick lookup spec-by-key for validation / coercion. */
export const SPEC_BY_KEY = Object.fromEntries(
  THRESHOLD_GROUPS.flatMap(g => g.items.map(i => [i.key, i])),
)

/**
 * Coerce a raw string value from operator_settings into a typed JS value.
 * Returns the default if the raw value is missing / invalid.
 *
 * @param {string} key
 * @param {string|null|undefined} raw
 * @returns {string|number|boolean}
 */
export function coerceValue(key, raw) {
  const spec = SPEC_BY_KEY[key]
  if (!spec) return raw ?? ''
  if (raw == null || raw === '') return spec.defaultValue
  if (spec.type === 'boolean') {
    if (raw === 'true' || raw === '1') return true
    if (raw === 'false' || raw === '0') return false
    return spec.defaultValue
  }
  if (spec.type === 'int') {
    const n = Number.parseInt(String(raw), 10)
    return Number.isFinite(n) ? n : spec.defaultValue
  }
  if (spec.type === 'float') {
    const n = Number.parseFloat(String(raw))
    return Number.isFinite(n) ? n : spec.defaultValue
  }
  return raw
}

/**
 * Validate a stringified candidate value against the spec.
 * Returns null on success or an error message.
 *
 * @param {string} key
 * @param {string} raw
 * @returns {string|null}
 */
export function validateValue(key, raw) {
  const spec = SPEC_BY_KEY[key]
  if (!spec) return `Neznámý klíč: ${key}`
  const trimmed = String(raw ?? '').trim()
  if (trimmed === '') return 'Hodnota nesmí být prázdná'
  if (spec.type === 'boolean') {
    if (trimmed !== 'true' && trimmed !== 'false') return 'Musí být „true" nebo „false"'
    return null
  }
  if (spec.type === 'int') {
    const n = Number.parseInt(trimmed, 10)
    if (!Number.isFinite(n) || String(n) !== trimmed) return 'Musí být celé číslo'
    if (typeof spec.min === 'number' && n < spec.min) return `Minimum: ${spec.min}`
    if (typeof spec.max === 'number' && n > spec.max) return `Maximum: ${spec.max}`
    return null
  }
  if (spec.type === 'float') {
    const n = Number.parseFloat(trimmed)
    if (!Number.isFinite(n)) return 'Musí být číslo'
    if (typeof spec.min === 'number' && n < spec.min) return `Minimum: ${spec.min}`
    if (typeof spec.max === 'number' && n > spec.max) return `Maximum: ${spec.max}`
    return null
  }
  return null
}
