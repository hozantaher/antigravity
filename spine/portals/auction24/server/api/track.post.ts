import { isRecoEventType, isRecoSurface, VID_COOKIE } from '~/models'
import { insertEventsBatch } from '../repos/recommendationRepo'
import { isRecoEnabled } from '../utils/reco'
import type { RecommendationEventInsert } from '../db/schema'

// Public ingest for the recommendation event stream (§3.7). Consent-gated (no vid cookie →
// silent 204, never block a fire-and-forget beacon), rate-limited, idempotent on the client
// event id, and returns 204 as fast as possible — no scoring on the hot path.
const MAX_EVENTS = 50

const finite = (v: unknown): number | null => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// Clamp a finite client number into its destination column's range so one oversized field can't
// overflow numeric/int4 and throw the whole batch INSERT (which would 500 a fire-and-forget beacon
// and drop the other co-batched events).
const clamped = (v: unknown, min: number, max: number): number | null => {
  const n = finite(v)
  return n == null ? null : Math.min(max, Math.max(min, n))
}
const clampedInt = (v: unknown, min: number, max: number): number | null =>
  Number.isInteger(v) ? Math.min(max, Math.max(min, v as number)) : null

// Untrusted client payload → bound every free-text/JSONB field. Without caps an unauthenticated
// beacon can write megabytes per event (storage DoS) and an arbitrary `surface` taints reco reports.
const cap = (v: unknown, n: number): string | null => (typeof v === 'string' ? v.slice(0, n) : null)
const boundMeta = (v: unknown): Record<string, unknown> | null => {
  // Reject arrays: pg serializes a JS array into a jsonb column as a PG array literal (invalid JSON).
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  try {
    return JSON.stringify(v).length <= 2048 ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export default defineEventHandler(async event => {
  enforceRateLimit(event, { bucket: 'track', limit: 60, windowMs: 60_000 })

  // Kill-switch + privacy gate: no writes when disabled or before consent (no vid).
  if (!isRecoEnabled()) return (setResponseStatus(event, 204), null)
  const vid = getCookie(event, VID_COOKIE)
  if (!vid) return (setResponseStatus(event, 204), null)

  const userId = (await getSessionUser(event))?.id ?? null
  const body = await readBody(event).catch(() => null)
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.slice(0, 64) : null
  const incoming: unknown[] = Array.isArray(body?.events) ? body.events.slice(0, MAX_EVENTS) : []

  const rows: RecommendationEventInsert[] = []
  for (const raw of incoming) {
    const e = raw as Record<string, unknown>
    if (typeof e?.id !== 'string' || !isRecoEventType(e?.type)) continue // drop invalid, never 400 a beacon
    const occurredAt = clamped(e.occurredAt, 0, 8_640_000_000_000_000) // valid JS Date ms range
    if (occurredAt == null) continue
    rows.push({
      id: e.id.slice(0, 64),
      vid,
      userId,
      sessionId,
      type: e.type,
      itemId: cap(e.itemId, 64),
      categoryId: cap(e.categoryId, 64),
      value: clamped(e.value, -1e12, 1e12),
      surface: isRecoSurface(e.surface) ? e.surface : null, // only the 4 real surfaces; junk would taint reco reports
      position: clampedInt(e.position, 0, 2_147_483_647),
      propensity: clamped(e.propensity, 0, 1),
      meta: boundMeta(e.meta),
      occurredAt: new Date(occurredAt),
    })
  }
  if (rows.length > 0) {
    // Fire-and-forget beacon: a malformed row or transient DB error must never 500 a track call
    // (the clamps above bound the known overflow vectors; this is defense-in-depth).
    try {
      await insertEventsBatch(rows)
    } catch (e) {
      captureServerError(e, { area: 'track.insert' })
    }
  }
  setResponseStatus(event, 204)
  return null
})
