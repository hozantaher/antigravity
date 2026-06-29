// MVP-4 — boot-time env validation for the BFF.
// Mirror of services/common/envconfig (Go) so missing env surfaces at boot,
// not on the first request five minutes later.
//
// Usage at top of server.js (before app.listen):
//   import { mustHaveEnv } from './src/lib/envconfig.js'
//   mustHaveEnv(['DATABASE_URL', 'OUTREACH_API_KEY', 'GO_SERVER_URL'])

/**
 * Validate a list of required env vars are non-empty. Returns the parsed
 * values when all present; throws (or process.exits in main mode) when any
 * are missing.
 *
 * @param {string[]} keys — required env var names
 * @param {{ exitOnFail?: boolean }} [opts] — exitOnFail=true (default) calls
 *   process.exit(2) on failure (matches preflight.sh exit code 2 = env missing)
 * @returns {Record<string, string>} — { KEY: value } for each present key
 */
export function mustHaveEnv(keys, { exitOnFail = true } = {}) {
  const missing = []
  const out = {}
  for (const k of keys) {
    const v = process.env[k]
    if (v === undefined || v === null || String(v).trim() === '') {
      missing.push(k)
    } else {
      out[k] = String(v)
    }
  }
  if (missing.length === 0) return out
  const msg = `[envconfig] missing required env: ${missing.join(', ')}`
  if (exitOnFail) {
    console.error(msg)
    console.error('[envconfig] aborting boot — fix env and restart (preflight exit code 2)')
    process.exit(2)
  }
  throw new Error(msg)
}

/**
 * Validate that env vars match a schema:
 *   { KEY: { required: true, validator?: (v) => true|errorMsg, default?: string } }
 * Returns the parsed values (with defaults applied).
 */
export function validateEnvSchema(schema, { exitOnFail = true } = {}) {
  const errors = []
  const out = {}
  for (const [key, spec] of Object.entries(schema)) {
    const raw = process.env[key]
    const present = raw !== undefined && raw !== null && String(raw).trim() !== ''
    if (!present) {
      if (spec.required && spec.default === undefined) {
        errors.push(`${key}: required, missing`)
        continue
      }
      out[key] = spec.default !== undefined ? spec.default : undefined
      continue
    }
    const v = String(raw)
    if (spec.validator) {
      const r = spec.validator(v)
      if (r !== true) {
        errors.push(`${key}: ${typeof r === 'string' ? r : 'invalid'}`)
        continue
      }
    }
    out[key] = v
  }
  if (errors.length === 0) return out
  const msg = `[envconfig] schema violations:\n  - ${errors.join('\n  - ')}`
  if (exitOnFail) {
    console.error(msg)
    process.exit(2)
  }
  throw new Error(msg)
}

// Common validators reusable across services.
export const validators = {
  url: (v) => {
    try { new URL(v); return true } catch { return 'not a valid URL' }
  },
  port: (v) => {
    const n = Number(v)
    return Number.isInteger(n) && n > 0 && n < 65536 ? true : 'not a valid port (1-65535)'
  },
  nonEmpty: (v) => String(v).trim().length > 0 ? true : 'must be non-empty',
  oneOf: (allowed) => (v) => allowed.includes(v) ? true : `must be one of: ${allowed.join(', ')}`,
}
