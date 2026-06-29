import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import type { Item } from '~/models'
import { useAdminItemVinDecode, applyNormalizedToForm } from '~/features/platform/admin/logic/useAdminItemVinDecode'

// The composable imports useToast at module load; stub it so tests don't need the toast plugin.
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))

describe('applyNormalizedToForm (offline result → form)', () => {
  it('routes manufacturer + year into item.specs and leaves item columns untouched', () => {
    const item = { specs: {} } as unknown as Item
    const stats = applyNormalizedToForm(item, { manufacturer: 'Škoda', yearOfManufacture: 2018 }, false)
    expect(item.specs!.manufacturer).toBe('Škoda')
    expect(item.specs!.yearOfManufacture).toBe(2018)
    expect(item.fuelType).toBeUndefined() // an offline result never fills the enum columns
    expect(stats.filled).toBe(2)
  })

  it('respects overwrite: false keeps existing values, true replaces them', () => {
    const item = { specs: { manufacturer: 'Audi' } } as unknown as Item
    applyNormalizedToForm(item, { manufacturer: 'Škoda' }, false)
    expect(item.specs!.manufacturer).toBe('Audi') // not clobbered
    applyNormalizedToForm(item, { manufacturer: 'Škoda' }, true)
    expect(item.specs!.manufacturer).toBe('Škoda') // overwritten
  })
})

describe('useAdminItemVinDecode.decodeOffline (client-side wiring)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn(() => {
      throw new Error('network must not be used by the offline decode')
    })
    vi.stubGlobal('$fetch', fetchMock)
  })

  it('decodes purely client-side: sets result/source/showResult and never calls $fetch', () => {
    const item = ref({ vin: 'TMBJF7NE0J0000000', specs: {} } as unknown as Item)
    const d = useAdminItemVinDecode(item)
    d.decodeOffline()
    expect(d.result.value?.normalized.manufacturer).toBe('Škoda')
    expect(d.source.value).toBe('offline')
    expect(d.showResult.value).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('applyResult fills the form from the offline result and closes the modal', () => {
    const item = ref({ vin: 'TMBJF7NE0J0000000', specs: {} } as unknown as Item)
    const d = useAdminItemVinDecode(item)
    d.decodeOffline()
    d.applyResult()
    expect(item.value.specs!.manufacturer).toBe('Škoda')
    expect(d.showResult.value).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does nothing for an invalid VIN (no result, no network)', () => {
    const item = ref({ vin: 'NOPE', specs: {} } as unknown as Item)
    const d = useAdminItemVinDecode(item)
    d.decodeOffline()
    expect(d.result.value).toBeNull()
    expect(d.showResult.value).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
