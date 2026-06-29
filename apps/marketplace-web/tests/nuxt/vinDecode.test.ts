import { beforeEach, describe, expect, it, vi } from 'vitest'

import { applyNormalizedToForm, useAdminItemVinDecode } from '~/features/platform/admin/logic/useAdminItemVinDecode'
import type { Item } from '~/models'

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
vi.mock('vue-toastification', () => ({ useToast: () => toast }))

beforeEach(() => vi.clearAllMocks())

describe('applyNormalizedToForm', () => {
  it('fills empty item columns and specs', () => {
    const item = { specs: {} } as Item
    const stats = applyNormalizedToForm(
      item,
      { fuelType: 'diesel', manufacturer: 'Audi', yearOfManufacture: 2015 } as never,
      false,
    )
    expect(item.fuelType).toBe('diesel')
    expect(item.specs!.manufacturer).toBe('Audi')
    expect(stats.filled).toBe(3)
  })

  it('skips non-empty fields unless overwrite is set', () => {
    const item = { fuelType: 'petrol', specs: { manufacturer: 'BMW' } } as Item
    expect(applyNormalizedToForm(item, { fuelType: 'diesel', manufacturer: 'Audi' } as never, false)).toEqual({
      filled: 0,
      skipped: 2,
    })
    expect(item.fuelType).toBe('petrol')
    expect(applyNormalizedToForm(item, { fuelType: 'diesel' } as never, true).filled).toBe(1)
    expect(item.fuelType).toBe('diesel')
  })

  it('ignores null/undefined normalized values and inits specs', () => {
    const item = {} as Item
    expect(applyNormalizedToForm(item, { fuelType: undefined, manufacturer: undefined } as never, false)).toEqual({
      filled: 0,
      skipped: 0,
    })
    applyNormalizedToForm(item, { manufacturer: 'Audi' } as never, false)
    expect(item.specs!.manufacturer).toBe('Audi')
  })

  it('treats an empty-string current value as fillable without overwrite', () => {
    const item = { fuelType: '', specs: { manufacturer: '' } } as unknown as Item
    const stats = applyNormalizedToForm(item, { fuelType: 'diesel', manufacturer: 'Audi' } as never, false)
    expect(item.fuelType).toBe('diesel')
    expect(item.specs!.manufacturer).toBe('Audi')
    expect(stats.filled).toBe(2)
    expect(stats.skipped).toBe(0)
  })

  it('fills the full long-tail spec set', () => {
    const item = { specs: {} } as Item
    const stats = applyNormalizedToForm(
      item,
      {
        transmission: 'manual',
        bodyType: 'sedan',
        driveType: 'fwd',
        enginePowerKw: 110,
        engineDisplacementCcm: 1984,
        model: 'A4',
        enginePowerHp: 150,
        numberOfGears: 6,
        emissionStandard: 'euro6',
        co2EmissionGkm: 120,
        numberOfDoors: 4,
        numberOfSeats: 5,
        numberOfAxles: 2,
        lengthMm: 4726,
        widthMm: 1842,
        heightMm: 1428,
        wheelbaseMm: 2820,
        weightEmptyKg: 1500,
        maxSpeedKmh: 210,
      } as never,
      false,
    )
    expect(stats.filled).toBe(19)
    expect(item.transmission).toBe('manual')
    expect(item.engineDisplacementCcm).toBe(1984)
    expect(item.specs!.maxSpeedKmh).toBe(210)
  })
})

describe('useAdminItemVinDecode', () => {
  it('canDecode reflects VIN validity', () => {
    const item = ref({ vin: 'WAUZZZ8K9AA123456' } as Item)
    const { canDecode } = useAdminItemVinDecode(item)
    expect(canDecode.value).toBe(true)
    item.value.vin = 'short'
    expect(canDecode.value).toBe(false)
  })

  it('rejects an invalid VIN without hitting the API', async () => {
    const f = vi.fn()
    vi.stubGlobal('$fetch', f)
    await useAdminItemVinDecode(ref({ vin: 'bad' } as Item)).decode()
    expect(f).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalled()
  })

  it('decodes a valid VIN, reveals the result, then applies it', async () => {
    vi.stubGlobal(
      '$fetch',
      vi.fn().mockResolvedValue({ vin: 'WAUZZZ8K9AA123456', normalized: { manufacturer: 'Audi' }, cached: false }),
    )
    const item = ref({ vin: 'wauzzz8k9aa123456', specs: {} } as Item)
    const vd = useAdminItemVinDecode(item)
    await vd.decode()
    expect(vd.result.value).toMatchObject({ cached: false })
    expect(vd.showResult.value).toBe(true)

    vd.applyResult()
    expect(item.value.specs?.manufacturer).toBe('Audi')
    expect(item.value.vin).toBe('WAUZZZ8K9AA123456') // normalized to the uppercased VIN
    expect(vd.showResult.value).toBe(false)
  })

  it('reports cached source and skipped count when applying', () => {
    vi.stubGlobal(
      '$fetch',
      vi.fn().mockResolvedValue({
        vin: 'WAUZZZ8K9AA123456',
        normalized: { manufacturer: 'Audi', fuelType: 'diesel' },
        cached: true,
      }),
    )
    const item = ref({ vin: 'WAUZZZ8K9AA123456', fuelType: 'petrol', specs: {} } as Item)
    const vd = useAdminItemVinDecode(item)
    return vd.decode().then(() => {
      vd.applyResult()
      expect(item.value.specs?.manufacturer).toBe('Audi')
      expect(item.value.fuelType).toBe('petrol') // skipped (non-empty, no overwrite)
      expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('from cache (free)'))
      expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('skipped 1'))
    })
  })

  it('applyResult is a no-op when there is no result', () => {
    const vd = useAdminItemVinDecode(ref({ vin: 'WAUZZZ8K9AA123456' } as Item))
    vd.applyResult()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('applyResult is a no-op when there is no item', () => {
    const vd = useAdminItemVinDecode(ref(undefined))
    vd.result.value = { vin: 'WAUZZZ8K9AA123456', normalized: { manufacturer: 'Audi' }, cached: false } as never
    vd.applyResult()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('surfaces the API data.statusMessage on failure', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue({ data: { statusMessage: 'VIN not found in registry' } }))
    const vd = useAdminItemVinDecode(ref({ vin: 'WAUZZZ8K9AA123456' } as Item))
    await vd.decode()
    expect(toast.error).toHaveBeenCalledWith('VIN not found in registry')
    expect(vd.showResult.value).toBe(false)
    expect(vd.decoding.value).toBe(false)
  })

  it('falls back to top-level statusMessage', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue({ statusMessage: 'Rate limited' }))
    const vd = useAdminItemVinDecode(ref({ vin: 'WAUZZZ8K9AA123456' } as Item))
    await vd.decode()
    expect(toast.error).toHaveBeenCalledWith('Rate limited')
  })

  it('falls back to the Error message', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(new Error('Network down')))
    const vd = useAdminItemVinDecode(ref({ vin: 'WAUZZZ8K9AA123456' } as Item))
    await vd.decode()
    expect(toast.error).toHaveBeenCalledWith('Network down')
  })

  it('falls back to the default message when the error is opaque', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue({}))
    const vd = useAdminItemVinDecode(ref({ vin: 'WAUZZZ8K9AA123456' } as Item))
    await vd.decode()
    expect(toast.error).toHaveBeenCalledWith('VIN decode failed')
  })
})
