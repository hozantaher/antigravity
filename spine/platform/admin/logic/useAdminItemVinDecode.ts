import type { Ref } from 'vue'
import { useToast } from 'vue-toastification'
import { isValidVin } from '~/features/supply/vehicle-vin/logic/vin'
import { decodeVinOffline } from '~/utils/offlineVin'
import type { Item, DecodeVinResponse, NormalizedVin } from '~/models'

// Which decode produced the current result: the paid Vincario full decode, or the free offline
// partial decode (manufacturer + year from the VIN structure). Drives the result badge.
export type VinDecodeSource = 'vincario' | 'offline'

export interface VinDecodeApplyStats {
  filled: number
  skipped: number
}

// Writes normalized VIN data onto the item. The enum/int fields are item columns; make/model/year
// and the long tail go into item.specs. With overwrite=false only empty targets are touched, so a
// decode never clobbers hand-entered values. Returns filled/skipped counts.
export const applyNormalizedToForm = (item: Item, n: NormalizedVin, overwrite: boolean): VinDecodeApplyStats => {
  const stats: VinDecodeApplyStats = { filled: 0, skipped: 0 }
  if (!item.specs) item.specs = {}
  const specs = item.specs

  const apply = <T>(current: T | undefined, value: T | undefined, set: (v: T) => void): void => {
    if (value == null) return
    if (overwrite || current == null || current === ('' as unknown as T)) {
      set(value)
      stats.filled += 1
    } else {
      stats.skipped += 1
    }
  }

  apply(item.fuelType, n.fuelType, v => (item.fuelType = v))
  apply(item.transmission, n.transmission, v => (item.transmission = v))
  apply(item.bodyType, n.bodyType, v => (item.bodyType = v))
  apply(item.driveType, n.driveType, v => (item.driveType = v))
  apply(item.enginePowerKw, n.enginePowerKw, v => (item.enginePowerKw = v))
  apply(item.engineDisplacementCcm, n.engineDisplacementCcm, v => (item.engineDisplacementCcm = v))

  apply(specs.manufacturer, n.manufacturer, v => (specs.manufacturer = v))
  apply(specs.model, n.model, v => (specs.model = v))
  apply(specs.yearOfManufacture, n.yearOfManufacture, v => (specs.yearOfManufacture = v))
  apply(specs.enginePowerHp, n.enginePowerHp, v => (specs.enginePowerHp = v))
  apply(specs.numberOfGears, n.numberOfGears, v => (specs.numberOfGears = v))
  apply(specs.emissionStandard, n.emissionStandard, v => (specs.emissionStandard = v))
  apply(specs.co2EmissionGkm, n.co2EmissionGkm, v => (specs.co2EmissionGkm = v))
  apply(specs.numberOfDoors, n.numberOfDoors, v => (specs.numberOfDoors = v))
  apply(specs.numberOfSeats, n.numberOfSeats, v => (specs.numberOfSeats = v))
  apply(specs.numberOfAxles, n.numberOfAxles, v => (specs.numberOfAxles = v))
  apply(specs.lengthMm, n.lengthMm, v => (specs.lengthMm = v))
  apply(specs.widthMm, n.widthMm, v => (specs.widthMm = v))
  apply(specs.heightMm, n.heightMm, v => (specs.heightMm = v))
  apply(specs.wheelbaseMm, n.wheelbaseMm, v => (specs.wheelbaseMm = v))
  apply(specs.weightEmptyKg, n.weightEmptyKg, v => (specs.weightEmptyKg = v))
  apply(specs.maxSpeedKmh, n.maxSpeedKmh, v => (specs.maxSpeedKmh = v))

  return stats
}

export const useAdminItemVinDecode = (item: Ref<Item | undefined>) => {
  const toast = useToast()
  const decoding = ref(false)
  const result = ref<DecodeVinResponse | null>(null)
  const showResult = ref(false)
  const overwrite = ref(false)
  const source = ref<VinDecodeSource>('vincario')

  const canDecode = computed(() => !decoding.value && isValidVin(item.value?.vin ?? ''))

  // Shared decode runner for both endpoints (paid Vincario + free offline). Auth header is injected
  // by plugins/api.client.ts for same-origin /api requests.
  const runDecode = async (url: string, src: VinDecodeSource) => {
    const vin = (item.value?.vin ?? '').trim().toUpperCase()
    if (!isValidVin(vin)) {
      toast.error('Invalid VIN — must be 17 characters (no I, O, Q).')
      return
    }
    decoding.value = true
    try {
      const res = await $fetch<DecodeVinResponse>(url, { method: 'POST', body: { vin } })
      result.value = res
      source.value = src
      overwrite.value = false
      showResult.value = true
    } catch (e) {
      const message =
        (e as { data?: { statusMessage?: string } }).data?.statusMessage ||
        (e as { statusMessage?: string }).statusMessage ||
        (e as Error).message ||
        'VIN decode failed'
      toast.error(message)
    } finally {
      decoding.value = false
    }
  }

  // Full, paid decode (Vincario): engine, dimensions, weight, emissions, … keyed by the VIN.
  const decode = () => runDecode('/api/admin/items/decode-vin', 'vincario')

  // Free, offline partial decode — pure VIN math, runs entirely client-side (no network, no auth):
  // only the fields ENCODED in the VIN itself (manufacturer + model year).
  const decodeOffline = () => {
    const vin = (item.value?.vin ?? '').trim().toUpperCase()
    if (!isValidVin(vin)) {
      toast.error('Invalid VIN — must be 17 characters (no I, O, Q).')
      return
    }
    const info = decodeVinOffline(vin)
    result.value = {
      vin,
      normalized: { manufacturer: info.manufacturer, yearOfManufacture: info.yearOfManufacture },
      cached: false,
      price: null,
      priceCurrency: null,
    }
    source.value = 'offline'
    overwrite.value = false
    showResult.value = true
  }

  const applyResult = () => {
    if (!result.value || !item.value) return
    const stats = applyNormalizedToForm(item.value, result.value.normalized, overwrite.value)
    item.value.vin = result.value.vin // normalize the input to the uppercased VIN
    const sourceLabel =
      source.value === 'offline' ? 'offline (free)' : result.value.cached ? 'from cache (free)' : 'decoded from VIN'
    toast.success(
      `Filled ${stats.filled} field(s)${stats.skipped ? `, skipped ${stats.skipped}` : ''} — ${sourceLabel}.`,
    )
    showResult.value = false
  }

  return { decoding, canDecode, decode, decodeOffline, source, result, showResult, overwrite, applyResult }
}
