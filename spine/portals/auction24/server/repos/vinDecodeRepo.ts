import { db } from '../utils/db'
import type { NormalizedVin, VincarioDecodeResponse } from '~/models'

export interface CachedVinDecode {
  vin: string
  normalized: NormalizedVin
  price: string | null
  priceCurrency: string | null
  decodedAt: Date
}

export const getCachedVinDecode = (vin: string): Promise<CachedVinDecode | undefined> =>
  db
    .selectFrom('vinDecodeCache')
    .select(['vin', 'normalized', 'price', 'priceCurrency', 'decodedAt'])
    .where('vin', '=', vin.toUpperCase())
    .executeTakeFirst()

export interface InsertVinDecodeInput {
  vin: string
  normalized: NormalizedVin
  rawResponse: VincarioDecodeResponse
  price: number | null
  priceCurrency: string | null
  decodedBy: string | null
}

// ON CONFLICT DO NOTHING: if two admins decode the same VIN in the same instant they both miss
// the cache and may both call Vincario, but only one row persists — no duplicate-key error.
export const insertVinDecodeCache = (input: InsertVinDecodeInput): Promise<unknown> =>
  db
    .insertInto('vinDecodeCache')
    .values({
      vin: input.vin.toUpperCase(),
      normalized: input.normalized,
      rawResponse: input.rawResponse,
      price: input.price != null ? String(input.price) : null,
      priceCurrency: input.priceCurrency,
      decodedBy: input.decodedBy,
    })
    .onConflict(oc => oc.column('vin').doNothing())
    .execute()
