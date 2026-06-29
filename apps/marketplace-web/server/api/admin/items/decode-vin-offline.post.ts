import { decodeVinOffline } from '~/utils/offlineVin'
import type { DecodeVinResponse } from '~/models'

// requireAdmin / enforceRateLimit / createError / readBody are Nitro auto-imports (bare globals).

// Free, offline PARTIAL VIN decode: manufacturer + model year, derived from the VIN structure itself
// (ISO 3779/3780) with no external call and no cost. Always available — it complements the paid
// Vincario full decode (which adds engine/dimensions/etc. that are NOT encoded in the VIN). Returns
// the same DecodeVinResponse shape so the editor's apply-to-form flow is reused unchanged.
export default defineEventHandler(async (event): Promise<DecodeVinResponse> => {
  const admin = await requireAdmin(event)
  enforceRateLimit(event, { bucket: 'admin-vin-offline', limit: 120, windowMs: 60_000, key: admin.id })

  const body = await readBody(event).catch(() => ({}))
  const vin = (typeof body?.vin === 'string' ? body.vin : '').trim().toUpperCase()

  const info = decodeVinOffline(vin)
  if (!info.valid) throw createError({ statusCode: 400, statusMessage: 'Invalid VIN (17 chars, no I/O/Q)' })

  return {
    vin,
    normalized: { manufacturer: info.manufacturer, yearOfManufacture: info.yearOfManufacture },
    cached: false,
    price: null,
    priceCurrency: null,
  }
})
