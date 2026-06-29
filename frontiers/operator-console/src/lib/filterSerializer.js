// URL ↔ CompanyFilters serializer. Pure, no React.
//
// Canonical filter shape lives here. Companies.jsx reads/writes through this.
// Changes here need a migration note if they break URLs users have bookmarked.

export const DEFAULTS = Object.freeze({
  q: '',
  icp: [],
  size: [],
  email: [],
  uncontacted: false,
  sort: 'score',
  dir: 'desc',
  offset: 0,
  cats: [],
  xcats: [],
  scoreMin: null,
  scoreMax: null,
  region: [],
  sector: [],
  engagement: [],
  lastContactedSince: null,
  lastContactedNever: false,
  emailConfidenceMin: null,
  hasWebsite: null,
})

const VALID_SORT = new Set(['score', 'name', 'city', 'contacted', 'email'])
const VALID_DIR = new Set(['asc', 'desc'])
const VALID_ICP = new Set(['ideal', 'good', 'unscored'])
const VALID_SIZE = new Set(['1-9', '10-49', '50-249', '250+'])
const VALID_EMAIL = new Set(['valid', 'risky', 'catch_all', 'role_only', 'invalid', 'unverified'])
const VALID_ENGAGEMENT = new Set(['cold', 'warm', 'hot'])

function parseCsv(raw, whitelist) {
  if (!raw) return []
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean)
  if (whitelist) return parts.filter(p => whitelist.has(p))
  return parts
}

function parseIntRange(raw, min, max) {
  if (raw == null || raw === '') return null
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n)) return null
  return Math.max(min, Math.min(max, n))
}

function parseIsoDate(raw) {
  if (!raw) return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : raw
}

/**
 * @param {URLSearchParams} params
 * @returns {typeof DEFAULTS}
 */
export function parseFilters(params) {
  // Legacy alias: `search` → `q`
  const qLegacy = params.get('search')
  const q = params.get('q') ?? qLegacy ?? DEFAULTS.q

  return {
    q,
    icp: parseCsv(params.get('icp'), VALID_ICP),
    size: parseCsv(params.get('size'), VALID_SIZE),
    email: parseCsv(params.get('email'), VALID_EMAIL),
    uncontacted: params.get('uncontacted') === '1',
    sort: VALID_SORT.has(params.get('sort')) ? params.get('sort') : DEFAULTS.sort,
    dir: VALID_DIR.has(params.get('dir')) ? params.get('dir') : DEFAULTS.dir,
    offset: parseIntRange(params.get('offset'), 0, 1_000_000) ?? 0,
    cats: parseCsv(params.get('cats')),
    xcats: parseCsv(params.get('xcats')),
    scoreMin: parseIntRange(params.get('scoreMin'), 0, 100),
    scoreMax: parseIntRange(params.get('scoreMax'), 0, 100),
    region: parseCsv(params.get('region')),
    sector: parseCsv(params.get('sector')),
    engagement: parseCsv(params.get('engagement'), VALID_ENGAGEMENT),
    lastContactedSince: parseIsoDate(params.get('lastContactedSince')),
    lastContactedNever: params.get('lastContactedNever') === '1',
    emailConfidenceMin: parseIntRange(params.get('emailConfidenceMin'), 0, 100),
    hasWebsite: params.get('hasWebsite') === '1' ? true
              : params.get('hasWebsite') === '0' ? false
              : null,
  }
}

/**
 * @param {typeof DEFAULTS} filters
 * @returns {URLSearchParams}
 */
export function serializeFilters(filters) {
  const p = new URLSearchParams()
  const set = (key, val) => {
    if (val === '' || val == null) return
    if (Array.isArray(val) && val.length === 0) return
    if (val === DEFAULTS[key]) return
    if (Array.isArray(val)) p.set(key, val.join(','))
    else if (typeof val === 'boolean') { if (val) p.set(key, '1') }
    else p.set(key, String(val))
  }
  set('q', filters.q)
  set('icp', filters.icp)
  set('size', filters.size)
  set('email', filters.email)
  set('uncontacted', filters.uncontacted)
  if (filters.sort !== DEFAULTS.sort) p.set('sort', filters.sort)
  if (filters.dir !== DEFAULTS.dir) p.set('dir', filters.dir)
  if (filters.offset && filters.offset !== 0) p.set('offset', String(filters.offset))
  set('cats', filters.cats)
  set('xcats', filters.xcats)
  if (filters.scoreMin != null) p.set('scoreMin', String(filters.scoreMin))
  if (filters.scoreMax != null) p.set('scoreMax', String(filters.scoreMax))
  set('region', filters.region)
  set('sector', filters.sector)
  set('engagement', filters.engagement)
  if (filters.lastContactedSince) p.set('lastContactedSince', filters.lastContactedSince)
  set('lastContactedNever', filters.lastContactedNever)
  if (filters.emailConfidenceMin != null) p.set('emailConfidenceMin', String(filters.emailConfidenceMin))
  if (filters.hasWebsite === true) p.set('hasWebsite', '1')
  else if (filters.hasWebsite === false) p.set('hasWebsite', '0')
  return p
}

/**
 * Map client-side filters → /api/companies query params (preserves legacy names).
 * @param {typeof DEFAULTS} filters
 * @param {{ limit?: number }} [opts]
 * @returns {URLSearchParams}
 */
export function toServerQuery(filters, opts = {}) {
  const p = new URLSearchParams()
  const limit = opts.limit ?? 50
  p.set('limit', String(limit))
  p.set('offset', String(filters.offset ?? 0))
  p.set('sort', filters.sort)
  p.set('dir', filters.dir)
  if (filters.q) p.set('search', filters.q)
  if (filters.icp.length) p.set('icp', filters.icp.join(','))
  if (filters.size.length) p.set('size', filters.size.join(','))
  if (filters.uncontacted) p.set('uncontacted', '1')
  filters.email.forEach(s => p.append('email_status[]', s))
  filters.cats.forEach(c => p.append('categories[]', c))
  filters.xcats.forEach(c => p.append('exclude_categories[]', c))
  if (filters.scoreMin != null) p.set('scoreMin', String(filters.scoreMin))
  if (filters.scoreMax != null) p.set('scoreMax', String(filters.scoreMax))
  filters.region.forEach(r => p.append('region[]', r))
  filters.sector.forEach(s => p.append('sector[]', s))
  filters.engagement.forEach(e => p.append('engagement[]', e))
  if (filters.lastContactedSince) p.set('lastContactedSince', filters.lastContactedSince)
  if (filters.lastContactedNever) p.set('lastContactedNever', '1')
  if (filters.emailConfidenceMin != null) p.set('emailConfidenceMin', String(filters.emailConfidenceMin))
  if (filters.hasWebsite === true) p.set('hasWebsite', '1')
  else if (filters.hasWebsite === false) p.set('hasWebsite', '0')
  return p
}

/**
 * @param {typeof DEFAULTS} filters
 */
export function hasActiveFilters(filters) {
  return activeFilterKeys(filters).length > 0
}

/**
 * Returns list of filter keys that are not at default value. Excludes sort/dir/offset.
 * @param {typeof DEFAULTS} filters
 * @returns {string[]}
 */
export function activeFilterKeys(filters) {
  const meta = new Set(['sort', 'dir', 'offset'])
  return Object.keys(DEFAULTS).filter(k => {
    if (meta.has(k)) return false
    const v = filters[k]
    const def = DEFAULTS[k]
    if (Array.isArray(def)) return Array.isArray(v) && v.length > 0
    return v !== def && v !== null
  })
}

/** Normalize: fill missing keys with defaults, coerce types. Safe for partial inputs. */
export function normalize(partial) {
  const out = { ...DEFAULTS }
  if (!partial) return out
  for (const k of Object.keys(DEFAULTS)) {
    if (partial[k] !== undefined) out[k] = partial[k]
  }
  return out
}
