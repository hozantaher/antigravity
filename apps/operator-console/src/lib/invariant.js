// Production-safe assertion library — Phase 7 Sprint I1 ("Tests as Heart").
//
// `invariant(condition, message, ctx)` runs at runtime and is meant to surface
// invariant violations in production WITHOUT crashing user-facing flows.
//
// Failure modes:
//   - non-prod (NODE_ENV !== 'production'):       100% logging + thrown
//     when INVARIANT_THROW=1 (default in dev/test)
//   - prod (NODE_ENV === 'production'):           sampled logging + breadcrumb,
//     never throws
//
// Sampling:
//   - non-prod                                    → 100%
//   - prod                                        → INVARIANT_SAMPLE_RATE
//                                                   (default 0.01 = 1%)
//
// All failures emit a Sentry breadcrumb of shape
//   { category: 'invariant', message, data: { ctx } }
// and a structured `console.warn('[invariant] …')` line.
//
// The thrown exception type is `InvariantViolation` (extends Error). It carries
// the original ctx for downstream handlers.
//
// Usage:
//   import { invariant, InvariantViolation } from './invariant.js'
//   invariant(user != null, 'user must be defined', { ctx: 'campaignRun' })
//   invariant(items.length > 0, 'items must not be empty')
//
//   const { passed, failed, warnings } = await runBootInvariants([
//     { name: 'db', fn: async () => pingDb(), severity: 'fatal' },
//   ])
//
//   guardTransition(machine, 'active', 'paused')
//
// All public exports are documented below with JSDoc.

/**
 * Error thrown by `invariant()` when INVARIANT_THROW=1 and condition is false,
 * and by `guardTransition()` for forbidden transitions.
 */
export class InvariantViolation extends Error {
  /**
   * @param {string} message
   * @param {unknown} [ctx]
   */
  constructor(message, ctx) {
    super(message)
    this.name = 'InvariantViolation'
    this.ctx = ctx
  }
}

/**
 * Returns the configured sample rate. In non-prod always 1.0 (always sample).
 * In prod reads INVARIANT_SAMPLE_RATE env var; defaults to 0.01.
 *
 * @returns {number} value in [0, 1]
 */
function currentSampleRate() {
  const env = (typeof process !== 'undefined' && process.env) || {}
  const isProd = env.NODE_ENV === 'production'
  if (!isProd) return 1
  const raw = env.INVARIANT_SAMPLE_RATE
  if (raw == null || raw === '') return 0.01
  const n = Number(raw)
  if (!Number.isFinite(n)) return 0.01
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

/**
 * Returns the throw flag — when true `invariant()` throws on failure.
 * Always true in non-prod; in prod only when INVARIANT_THROW=1.
 */
function shouldThrow() {
  const env = (typeof process !== 'undefined' && process.env) || {}
  if (env.INVARIANT_THROW === '1') return true
  // Default: throw in non-prod (helps tests fail loud)
  if (env.NODE_ENV !== 'production') return true
  return false
}

/**
 * Best-effort Sentry breadcrumb emitter. Never throws — Sentry must not block
 * the calling path. Tries `@sentry/node` first, then `@sentry/react`, falling
 * back silently when neither is initialised.
 *
 * @param {string} message
 * @param {unknown} ctx
 */
async function emitBreadcrumb(message, ctx) {
  try {
    // Prefer node when available (BFF) — both packages share the same API
    let Sentry = null
    try {
      Sentry = await import('@sentry/node')
    } catch {
      try {
        Sentry = await import('@sentry/react')
      } catch {
        Sentry = null
      }
    }
    if (Sentry && typeof Sentry.addBreadcrumb === 'function') {
      Sentry.addBreadcrumb({
        category: 'invariant',
        level: 'warning',
        message: String(message),
        data: ctx == null ? {} : { ctx },
      })
    }
  } catch {
    // never block on telemetry failure
  }
}

/**
 * Coerces a non-string message into a string. `null`/`undefined` collapses to
 * the literal string 'invariant violation'.
 *
 * @param {unknown} m
 * @returns {string}
 */
function coerceMessage(m) {
  if (m == null) return 'invariant violation'
  if (typeof m === 'string') return m
  try {
    return String(m)
  } catch {
    return 'invariant violation'
  }
}

/**
 * Production-safe assertion.
 *
 * If `condition` is truthy, this is a no-op (~3ns). Otherwise:
 *   1. Sample-decide whether to log (always in non-prod, INVARIANT_SAMPLE_RATE
 *      in prod, default 1%).
 *   2. If sampled, emit `console.warn('[invariant] …')` + Sentry breadcrumb.
 *   3. If `INVARIANT_THROW=1` (or NODE_ENV !== 'production'), throw
 *      `InvariantViolation`. Otherwise return silently.
 *
 * Pre-typed parameter notes:
 *   - `condition`: any truthy/falsy value. `undefined` is treated as false.
 *   - `message`: stringified safely if not already a string.
 *   - `ctx`:     attached to breadcrumb data and to the thrown exception.
 *
 * @param {unknown} condition
 * @param {unknown} message
 * @param {unknown} [ctx]
 * @returns {void}
 */
export function invariant(condition, message, ctx = null) {
  // Fast-path: truthy condition skips everything.
  if (condition) return

  const msg = coerceMessage(message)

  // Sample-decide whether to log.
  const rate = currentSampleRate()
  const sampled = rate >= 1 ? true : rate <= 0 ? false : Math.random() < rate

  if (sampled) {
    // Structured warn line — picked up by log aggregators.
    try {
      const ctxStr = ctx == null ? '' : ` ctx=${JSON.stringify(ctx)}`
      // eslint-disable-next-line no-console
      console.warn(`[invariant] ${msg}${ctxStr}`)
    } catch {
      // eslint-disable-next-line no-console
      console.warn(`[invariant] ${msg}`)
    }
    // Fire-and-forget breadcrumb — don't await on hot path.
    emitBreadcrumb(msg, ctx)
  }

  if (shouldThrow()) {
    throw new InvariantViolation(msg, ctx)
  }
}

/**
 * Boot-time invariant suite. Each check is `{ name, fn, severity }`:
 *   - `severity: 'fatal'` — failure throws InvariantViolation (server must abort)
 *   - `severity: 'warn'`  — failure logged + counted, never throws
 *
 * Returns `{ passed, failed, warnings, results }`.
 *
 * Usage at server boot:
 *   const summary = await runBootInvariants([
 *     { name: 'db', fn: async () => pingDb(), severity: 'fatal' },
 *     { name: 'go-backend', fn: async () => pingGo(), severity: 'warn' },
 *   ])
 *   if (summary.failed > 0) process.exit(1)
 *
 * @param {Array<{name: string, fn: () => (boolean|Promise<boolean>), severity: 'fatal'|'warn'}>} checks
 * @returns {Promise<{passed: number, failed: number, warnings: number, results: Array<{name: string, ok: boolean, severity: string, error?: string}>}>}
 */
export async function runBootInvariants(checks) {
  if (!Array.isArray(checks)) {
    throw new InvariantViolation('runBootInvariants: checks must be an array', { received: typeof checks })
  }

  let passed = 0
  let failed = 0
  let warnings = 0
  const results = []

  for (const check of checks) {
    if (!check || typeof check.name !== 'string' || typeof check.fn !== 'function') {
      throw new InvariantViolation('runBootInvariants: each check needs { name, fn, severity }')
    }
    const severity = check.severity === 'fatal' ? 'fatal' : 'warn'
    let ok = false
    let errorMsg
    try {
      ok = Boolean(await check.fn())
    } catch (e) {
      ok = false
      errorMsg = e instanceof Error ? e.message : String(e)
    }

    if (ok) {
      passed++
      results.push({ name: check.name, ok: true, severity })
      continue
    }

    // Fail.
    const result = { name: check.name, ok: false, severity }
    if (errorMsg) result.error = errorMsg
    results.push(result)

    try {
      // eslint-disable-next-line no-console
      console.warn(`[invariant:boot] ${severity.toUpperCase()} check "${check.name}" failed${errorMsg ? `: ${errorMsg}` : ''}`)
    } catch {
      /* noop */
    }
    emitBreadcrumb(`boot invariant "${check.name}" failed`, { severity, error: errorMsg })

    if (severity === 'fatal') {
      failed++
      // Fatal severity always throws — even when shouldThrow() is false.
      throw new InvariantViolation(
        `boot invariant "${check.name}" failed`,
        { name: check.name, error: errorMsg },
      )
    } else {
      warnings++
    }
  }

  return { passed, failed, warnings, results }
}

/**
 * Validates a state-machine transition. The `stateMachine` argument must
 * expose `canTransition(from, to) => boolean`.
 *
 * Throws `InvariantViolation` when the transition is not allowed.
 * Returns `true` when allowed.
 *
 * Used by mailbox lifecycle (active → paused → needs_human, etc.).
 *
 * @param {{ canTransition: (from: string, to: string) => boolean }} stateMachine
 * @param {string} from
 * @param {string} to
 * @returns {true}
 */
export function guardTransition(stateMachine, from, to) {
  if (!stateMachine || typeof stateMachine.canTransition !== 'function') {
    throw new InvariantViolation('guardTransition: stateMachine.canTransition is required')
  }
  let allowed = false
  try {
    allowed = Boolean(stateMachine.canTransition(from, to))
  } catch (e) {
    throw new InvariantViolation(
      `guardTransition: canTransition threw for ${from}→${to}`,
      { from, to, error: e instanceof Error ? e.message : String(e) },
    )
  }
  if (!allowed) {
    throw new InvariantViolation(
      `forbidden transition ${from} → ${to}`,
      { from, to },
    )
  }
  return true
}
