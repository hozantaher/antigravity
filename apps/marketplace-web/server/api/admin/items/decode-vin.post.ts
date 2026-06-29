import { requireAdmin } from '../../../utils/session'
import { enforceRateLimit } from '../../../utils/rateLimit'
import { captureServerError } from '../../../utils/observability'
import { decodeVinRemote, VincarioError } from '../../../utils/vincario'
import { normalizeVinDecode, countNormalizedFields } from '../../../utils/vincarioNormalize'
import { getCachedVinDecode, insertVinDecodeCache } from '../../../repos/vinDecodeRepo'
import { VIN_RE } from '~/features/supply/vehicle-vin/logic/vin'
import type { DecodeVinResponse } from '~/models'

const mapVincarioToHttp = (err: VincarioError) => {
  switch (err.kind) {
    case 'not_configured':
      return createError({ statusCode: 500, statusMessage: 'Vincario is not configured' })
    case 'insufficient_balance':
      return createError({ statusCode: 402, statusMessage: 'Insufficient Vincario credit' })
    case 'rate_limited':
      return createError({ statusCode: 429, statusMessage: 'Vincario: too many requests' })
    case 'auth':
      return createError({ statusCode: 502, statusMessage: 'Vincario authentication error' })
    default:
      return createError({ statusCode: 502, statusMessage: 'Vincario service is unavailable' })
  }
}

export default defineEventHandler(async (event): Promise<DecodeVinResponse> => {
  const admin = await requireAdmin(event)
  enforceRateLimit(event, { bucket: 'admin-vin-decode', limit: 30, windowMs: 60_000, key: admin.id })

  const body = await readBody(event).catch(() => ({}))
  const vin = (typeof body?.vin === 'string' ? body.vin : '').trim().toUpperCase()
  if (!VIN_RE.test(vin)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid VIN (17 chars, no I/O/Q)' })
  }

  // Durable cache check before spending a credit — repeat decodes of a VIN are free.
  const cached = await getCachedVinDecode(vin)
  if (cached) {
    return {
      vin,
      normalized: cached.normalized,
      cached: true,
      price: cached.price != null ? Number(cached.price) : null,
      priceCurrency: cached.priceCurrency,
    }
  }

  const raw = await decodeVinRemote(vin).catch((err: unknown) => {
    if (err instanceof VincarioError) {
      // not_configured is an ops misconfig, not a Vincario outage — don't report it.
      if (err.kind !== 'not_configured') {
        captureServerError(err, { area: 'vincario.decode', tags: { kind: err.kind } })
      }
      throw mapVincarioToHttp(err)
    }
    captureServerError(err, { area: 'vincario.decode' })
    throw createError({ statusCode: 502, statusMessage: 'Vincario service is unavailable' })
  })

  const normalized = normalizeVinDecode(raw.decode)
  // Unknown VIN → Vincario returns a sparse/empty decode. Don't cache it: a later-covered VIN
  // should stay decodable, and there's nothing to fill anyway.
  if (countNormalizedFields(normalized) === 0) {
    throw createError({ statusCode: 404, statusMessage: 'VIN not recognized' })
  }

  await insertVinDecodeCache({
    vin,
    normalized,
    rawResponse: raw,
    price: raw.price ?? null,
    priceCurrency: raw.price_currency ?? null,
    decodedBy: admin.id,
  })

  return { vin, normalized, cached: false, price: raw.price ?? null, priceCurrency: raw.price_currency ?? null }
})
