import { sql, type Updateable } from 'kysely'
import { deeplLocales } from '~/utils'
import type { AdHighlight, Item, NormalizedVin, VehicleSpecs } from '~/models'
import { db } from './db'
import type { ItemsTable } from '../db/schema'
import { getById } from '../repos/itemRepo'
import { getCachedVinDecode, insertVinDecodeCache } from '../repos/vinDecodeRepo'
import { decodeVinRemote } from './vincario'
import { normalizeVinDecode, countNormalizedFields } from './vincarioNormalize'
import { translateTexts } from './deepl'
import { ENRICHABLE_LOCALES, pickSourceLocale } from './enrich'
import { captureServerError } from './observability'

const BATCH_LIMIT = 20
// A row stuck 'processing' longer than this is re-eligible — crash recovery, mirrors the Fio window.
const CLAIM_TIMEOUT_MS = 5 * 60_000

export interface EnrichResult {
  claimed: number
  vinFilled: number
  translated: number
  failed: number
}

// Decode a VIN via the durable cache, falling back to Vincario on a miss (and caching the result).
// Returns undefined for an unrecognized VIN (nothing to fill).
const getOrDecodeVin = async (vin: string): Promise<NormalizedVin | undefined> => {
  const cached = await getCachedVinDecode(vin)
  if (cached) return cached.normalized
  const raw = await decodeVinRemote(vin)
  const normalized = normalizeVinDecode(raw.decode)
  if (countNormalizedFields(normalized) === 0) return undefined
  await insertVinDecodeCache({
    vin,
    normalized,
    rawResponse: raw,
    price: raw.price ?? null,
    priceCurrency: raw.price_currency ?? null,
    decodedBy: null,
  })
  return normalized
}

// Build a patch of ONLY the empty vehicle fields from decoded VIN data (never overwrite hand-entered
// values). Mirrors applyNormalizedToForm (the editor's manual apply) on the server.
const buildVinPatch = (
  item: Item,
  n: NormalizedVin,
): { cols: Updateable<ItemsTable>; specs: Partial<VehicleSpecs>; filled: number } => {
  const cols: Updateable<ItemsTable> = {}
  const specs: Partial<VehicleSpecs> = {}
  let filled = 0
  const fill = <T>(current: T | null | undefined, value: T | undefined, set: (v: T) => void): void => {
    if (value == null) return
    if (current == null || current === ('' as unknown as T)) {
      set(value)
      filled += 1
    }
  }

  fill(item.fuelType, n.fuelType, v => (cols.fuelType = v))
  fill(item.transmission, n.transmission, v => (cols.transmission = v))
  fill(item.bodyType, n.bodyType, v => (cols.bodyType = v))
  fill(item.driveType, n.driveType, v => (cols.driveType = v))
  fill(item.enginePowerKw, n.enginePowerKw, v => (cols.enginePowerKw = v))
  fill(item.engineDisplacementCcm, n.engineDisplacementCcm, v => (cols.engineDisplacementCcm = v))

  const s = item.specs ?? {}
  fill(s.manufacturer, n.manufacturer, v => (specs.manufacturer = v))
  fill(s.model, n.model, v => (specs.model = v))
  fill(s.yearOfManufacture, n.yearOfManufacture, v => (specs.yearOfManufacture = v))
  fill(s.enginePowerHp, n.enginePowerHp, v => (specs.enginePowerHp = v))
  fill(s.numberOfGears, n.numberOfGears, v => (specs.numberOfGears = v))
  fill(s.emissionStandard, n.emissionStandard, v => (specs.emissionStandard = v))
  fill(s.co2EmissionGkm, n.co2EmissionGkm, v => (specs.co2EmissionGkm = v))
  fill(s.numberOfDoors, n.numberOfDoors, v => (specs.numberOfDoors = v))
  fill(s.numberOfSeats, n.numberOfSeats, v => (specs.numberOfSeats = v))
  fill(s.numberOfAxles, n.numberOfAxles, v => (specs.numberOfAxles = v))
  fill(s.lengthMm, n.lengthMm, v => (specs.lengthMm = v))
  fill(s.widthMm, n.widthMm, v => (specs.widthMm = v))
  fill(s.heightMm, n.heightMm, v => (specs.heightMm = v))
  fill(s.wheelbaseMm, n.wheelbaseMm, v => (specs.wheelbaseMm = v))
  fill(s.weightEmptyKg, n.weightEmptyKg, v => (specs.weightEmptyKg = v))
  fill(s.maxSpeedKmh, n.maxSpeedKmh, v => (specs.maxSpeedKmh = v))

  return { cols, specs, filled }
}

// Translate the description into any empty enrichable locale, from the first locale that has text.
// Returns the new description map (or undefined when nothing was filled).
const buildTranslationPatch = async (item: Item): Promise<Record<string, string> | undefined> => {
  const desc = item.description ?? {}
  const src = pickSourceLocale(desc)
  const sourceText = src ? desc[src]?.trim() : undefined
  if (!src || !sourceText) return undefined
  const targets = ENRICHABLE_LOCALES.filter(l => l !== src && !desc[l]?.trim())
  if (targets.length === 0) return undefined

  const next: Record<string, string> = { ...desc }
  let any = false
  for (const locale of targets) {
    const [translated] = await translateTexts([sourceText], deeplLocales[locale]!, deeplLocales[src])
    if (translated) {
      next[locale] = translated
      any = true
    }
  }
  return any ? next : undefined
}

// Translate highlights into any empty enrichable locale, mirroring the editor's manual flow: values
// are translated; titles are translated too EXCEPT param-bound titles (paramId), which stay as the
// source title (they're keyed labels, not free text).
const buildHighlightsPatch = async (item: Item): Promise<Record<string, AdHighlight[]> | undefined> => {
  const hl = item.highlights ?? {}
  const src = pickSourceLocale(hl)
  const source = src ? hl[src] : undefined
  if (!src || !source || source.length === 0) return undefined
  const targets = ENRICHABLE_LOCALES.filter(l => l !== src && !hl[l]?.length)
  if (targets.length === 0) return undefined

  const next: Record<string, AdHighlight[]> = { ...hl }
  for (const locale of targets) {
    const values = await translateTexts(
      source.map(h => h.value),
      deeplLocales[locale]!,
      deeplLocales[src],
    )
    const titles = await translateTexts(
      source.map(h => h.title),
      deeplLocales[locale]!,
      deeplLocales[src],
    )
    next[locale] = source.map((h, i) => ({
      value: values[i] ?? h.value,
      title: h.paramId ? h.title : (titles[i] ?? h.title),
      paramId: h.paramId,
    }))
  }
  return next
}

// Crash-safe enrichment sweep. Mirrors auctionCloser/processFioPayments: claim each pending row with
// a CAS, do the deterministic work (VIN decode + DeepL into empties), per-item try/catch so one bad
// row never aborts the batch. Only fills empty fields and never touches internalId — safe for
// admin-created and feed-imported (AutoLine) items alike.
export const enrichListings = async (limit = BATCH_LIMIT): Promise<EnrichResult> => {
  const result: EnrichResult = { claimed: 0, vinFilled: 0, translated: 0, failed: 0 }
  const cfg = useRuntimeConfig()
  const vincarioOn = !!cfg.vincarioApiKey && !!cfg.vincarioSecretKey
  const deeplOn = !!cfg.deeplApiKey
  if (!vincarioOn && !deeplOn) return result

  const staleBefore = new Date(Date.now() - CLAIM_TIMEOUT_MS)

  const candidates = await db
    .selectFrom('items')
    .select('id')
    .where(eb =>
      eb.or([
        eb('enrichmentStatus', '=', 'pending'),
        eb.and([eb('enrichmentStatus', '=', 'processing'), eb('enrichmentClaimedAt', '<', staleBefore)]),
      ]),
    )
    .limit(limit)
    .execute()

  for (const { id } of candidates) {
    // Claim: flip to 'processing' only if still pending (or a stale processing row). A lost CAS means
    // another worker took it — skip.
    const claim = await db
      .updateTable('items')
      .set({ enrichmentStatus: 'processing', enrichmentClaimedAt: new Date() })
      .where('id', '=', id)
      .where(eb =>
        eb.or([
          eb('enrichmentStatus', '=', 'pending'),
          eb.and([eb('enrichmentStatus', '=', 'processing'), eb('enrichmentClaimedAt', '<', staleBefore)]),
        ]),
      )
      .executeTakeFirst()
    if (Number(claim.numUpdatedRows ?? 0) === 0) continue
    result.claimed += 1

    try {
      const item = await getById(id)
      if (!item) {
        await db
          .updateTable('items')
          .set({ enrichmentStatus: 'ready', enrichmentClaimedAt: null })
          .where('id', '=', id)
          .execute()
        continue
      }

      const patch: Updateable<ItemsTable> = {}

      if (vincarioOn && item.vin?.trim() && !item.specs?.manufacturer) {
        const normalized = await getOrDecodeVin(item.vin.trim().toUpperCase())
        if (normalized) {
          const { cols, specs, filled } = buildVinPatch(item, normalized)
          Object.assign(patch, cols)
          if (Object.keys(specs).length > 0) patch.specs = { ...(item.specs ?? {}), ...specs }
          if (filled > 0) result.vinFilled += 1
        }
      }

      if (deeplOn) {
        const nextDesc = await buildTranslationPatch(item)
        const nextHl = await buildHighlightsPatch(item)
        if (nextDesc) patch.description = nextDesc
        if (nextHl) patch.highlights = nextHl
        if (nextDesc || nextHl) result.translated += 1
      }

      await db
        .updateTable('items')
        .set({ ...patch, enrichmentStatus: 'ready', enrichmentClaimedAt: null, enrichmentError: null })
        .where('id', '=', id)
        .execute()
    } catch (e) {
      result.failed += 1
      captureServerError(e, { area: 'enrich.listing', tags: { id } })
      await db
        .updateTable('items')
        .set({
          enrichmentStatus: 'failed',
          enrichmentClaimedAt: null,
          enrichmentError: e instanceof Error ? e.message : String(e),
          enrichmentAttempts: sql`enrichment_attempts + 1`,
        })
        .where('id', '=', id)
        .execute()
    }
  }

  return result
}
