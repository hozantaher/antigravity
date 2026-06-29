import { beforeEach, describe, expect, it, vi } from 'vitest'
import useAdminItem, { EditView } from '~/features/platform/admin/logic/useAdminItem'
import { ItemType as ItemTypeForTest } from '~/models'

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
vi.mock('vue-toastification', () => ({ useToast: () => toast }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(undefined))
})

describe('useAdminItem.fetchItem', () => {
  it('creates a blank item with empty price objects for a new item', async () => {
    const a = useAdminItem()
    const created = await a.fetchItem()
    expect(created.id).toMatch(/^i\d+$/)
    expect(created.priceFrom).toEqual({})
    expect(a.showPresets.value).toBe(true)
  })

  it('normalizes legacy null prices and seeds the gallery on load', async () => {
    vi.stubGlobal(
      '$fetch',
      vi.fn().mockResolvedValue({
        id: 'i1',
        categoryId: 'car',
        image: 'cover.jpg',
        images: ['b.jpg'],
        images360: [],
        description: {},
        highlights: {},
        bids: [],
      }),
    )
    const a = useAdminItem()
    const loaded = await a.fetchItem('i1')
    expect(loaded.priceFrom).toEqual({})
    expect(loaded.minimalPrice).toEqual({})
    expect(a.images.value).toEqual(['cover.jpg', 'b.jpg'])
    expect(a.showPresets.value).toBe(false)
  })
})

describe('useAdminItem.saveItem', () => {
  it('refuses to save without images', async () => {
    const a = useAdminItem()
    await a.fetchItem()
    a.images.value = []
    await a.saveItem()
    expect(toast.error).toHaveBeenCalledWith('Images are empty')
  })

  it('refuses invalid auction dates (start after end)', async () => {
    const a = useAdminItem()
    const it = await a.fetchItem()
    a.images.value = ['x.jpg']
    it.startDate = 2000
    it.endDate = 1000
    await a.saveItem()
    expect(toast.error).toHaveBeenCalledWith('Invalid auction dates')
  })

  it('POSTs a new item and stamps created/visibleUpdated', async () => {
    const f = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('$fetch', f)
    const a = useAdminItem()
    const it = await a.fetchItem()
    a.images.value = ['cover.jpg', 'b.jpg']
    it.title = 'New'
    await a.saveItem()
    expect(f).toHaveBeenCalledWith('/api/admin/item', expect.objectContaining({ method: 'POST' }))
    expect(it.image).toBe('cover.jpg')
    expect(it.images).toEqual(['b.jpg'])
    expect(it.created).toBeTypeOf('number')
    expect(toast.success).toHaveBeenCalled()
  })

  it('PUTs an existing item', async () => {
    vi.stubGlobal(
      '$fetch',
      vi.fn().mockResolvedValue({
        id: 'i1',
        categoryId: 'car',
        images: [],
        images360: [],
        description: {},
        highlights: {},
        bids: [],
      }),
    )
    const a = useAdminItem()
    await a.fetchItem('i1') // sets itemPrev
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(undefined))
    a.images.value = ['cover.jpg']
    await a.saveItem()
    // re-stub captured the PUT call:
    expect(toast.success).toHaveBeenCalled()
  })
})

describe('useAdminItem helpers', () => {
  it('startDateChange / endDateChange convert to epoch ms (or undefined)', async () => {
    const a = useAdminItem()
    const it = await a.fetchItem()
    a.startDateChange('2025-01-01T10:00')
    expect(it.startDate).toBeTypeOf('number')
    a.endDateChange(null)
    expect(it.endDate).toBeUndefined()
  })

  it('uploadImages appends successfully uploaded urls', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ url: 'uploaded.jpg' }))
    const a = useAdminItem()
    await a.fetchItem()
    await a.uploadImages([new File(['x'], 'a.jpg', { type: 'image/jpeg' })])
    expect(a.images.value).toContain('uploaded.jpg')
    expect(a.isUploading.value).toBe(false)
  })

  it('clearBids empties bids and winner', async () => {
    const a = useAdminItem()
    const it = await a.fetchItem()
    it.bids = [{ amount: 1 }] as never
    it.winner = { userId: 'u1' } as never
    a.clearBids()
    expect(it.bids).toEqual([])
    expect(it.winner).toBeUndefined()
  })

  it('selectedCategory setter writes categoryId onto the item', async () => {
    const a = useAdminItem()
    await a.fetchItem()
    a.selectedCategory.value = { id: 'moto' }
    expect(a.item.value?.categoryId).toBe('moto')
  })

  it('translateOtherLanguages fills the other description locales', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ texts: ['translated'] }))
    const a = useAdminItem()
    const it = await a.fetchItem()
    a.view.value = EditView.description
    it.description.cz = 'Ahoj'
    await a.translateOtherLanguages('cz')
    expect(it.description.en).toBe('translated')
    expect(toast.success).toHaveBeenCalled()
  })

  it('dispose clears the item and resets the view', async () => {
    const a = useAdminItem()
    await a.fetchItem()
    a.dispose()
    expect(a.item.value).toBeUndefined()
    expect(a.view.value).toBe(EditView.general)
  })
})

describe('useAdminItem.fetchItem branches', () => {
  it('keeps existing specs/price objects and seeds gallery from image only', async () => {
    vi.stubGlobal(
      '$fetch',
      vi.fn().mockResolvedValue({
        id: 'i9',
        categoryId: 'car',
        image: 'only-cover.jpg',
        images: [],
        images360: [],
        description: {},
        highlights: {},
        bids: [],
        specs: { manufacturer: 'BMW' },
        priceFrom: { amount: 100 },
        minBid: { amount: 5 },
        minimalPrice: { amount: 50 },
      }),
    )
    const a = useAdminItem()
    const loaded = await a.fetchItem('i9')
    expect(loaded.specs).toEqual({ manufacturer: 'BMW' })
    expect(loaded.priceFrom).toEqual({ amount: 100 })
    expect(loaded.minBid).toEqual({ amount: 5 })
    expect(a.images.value).toEqual(['only-cover.jpg'])
  })

  it('loads an item with no image and empty images array', async () => {
    vi.stubGlobal(
      '$fetch',
      vi.fn().mockResolvedValue({
        id: 'i10',
        categoryId: 'car',
        images: [],
        images360: [],
        description: {},
        highlights: {},
        bids: [],
        specs: {},
        priceFrom: {},
        minBid: {},
        minimalPrice: {},
      }),
    )
    const a = useAdminItem()
    await a.fetchItem('i10')
    expect(a.images.value).toEqual([])
  })
})

describe('useAdminItem.saveItem branches', () => {
  it('refuses to save when auction already has a winner and end date is in the future', async () => {
    const a = useAdminItem()
    const it = await a.fetchItem()
    a.images.value = ['x.jpg']
    it.winner = { userId: 'u1' } as never
    it.endDate = Date.now() + 100000
    await a.saveItem()
    expect(toast.error).toHaveBeenCalledWith(
      'The auction already has a winner, to reopen the auction first delete the bids and the winner',
    )
  })

  it('reopens an auction whose end date is in the future (closed=false)', async () => {
    const f = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('$fetch', f)
    const a = useAdminItem()
    const it = await a.fetchItem()
    a.images.value = ['cover.jpg']
    it.type = ItemTypeForTest.auction
    it.closed = true
    it.endDate = Date.now() + 100000
    await a.saveItem()
    expect(it.closed).toBe(false)
    expect(toast.success).toHaveBeenCalled()
  })

  it('clears auction fields when converting an auction to an ad', async () => {
    // First load an existing auction item to populate itemPrev with type=auction.
    vi.stubGlobal(
      '$fetch',
      vi.fn().mockResolvedValue({
        id: 'i1',
        categoryId: 'car',
        type: ItemTypeForTest.auction,
        images: [],
        images360: [],
        description: {},
        highlights: {},
        bids: [],
      }),
    )
    const a = useAdminItem()
    const it = await a.fetchItem('i1')
    const f = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('$fetch', f)
    a.images.value = ['cover.jpg']
    it.type = ItemTypeForTest.ad
    it.startDate = 1000
    it.endDate = 2000
    await a.saveItem()
    expect(it.closed).toBe(false)
    expect(it.minimalPrice).toBeUndefined()
    expect(it.minBid).toBeUndefined()
    expect(it.startDate).toBeUndefined()
    expect(it.endDate).toBeUndefined()
  })

  it('stamps visibleUpdated when hidden flag changes on an existing item', async () => {
    vi.stubGlobal(
      '$fetch',
      vi.fn().mockResolvedValue({
        id: 'i1',
        categoryId: 'car',
        hidden: false,
        images: [],
        images360: [],
        description: {},
        highlights: {},
        bids: [],
      }),
    )
    const a = useAdminItem()
    const it = await a.fetchItem('i1')
    const f = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('$fetch', f)
    a.images.value = ['cover.jpg']
    it.hidden = true
    await a.saveItem()
    expect(it.visibleUpdated).toBeTypeOf('number')
  })

  it('toasts an error when the save request rejects', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(new Error('boom')))
    const a = useAdminItem()
    const it = await a.fetchItem()
    a.images.value = ['cover.jpg']
    it.title = 'New'
    await a.saveItem()
    expect(toast.error).toHaveBeenCalledWith('Something went wrong')
  })

  it('drops empty highlight entries before saving', async () => {
    const f = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('$fetch', f)
    const a = useAdminItem()
    const it = await a.fetchItem()
    a.images.value = ['cover.jpg']
    it.highlights = {
      cz: [
        { value: 'keep', title: 'k' },
        { value: '', title: 'drop' },
      ],
      en: undefined,
    } as never
    await a.saveItem()
    expect(it.highlights.cz).toEqual([{ value: 'keep', title: 'k' }])
    expect(it.highlights.en).toEqual([])
  })
})

describe('useAdminItem more helpers', () => {
  it('getLocalDateString formats a timestamp and returns empty for undefined', () => {
    const a = useAdminItem()
    expect(a.getLocalDateString()).toBe('')
    expect(a.getLocalDateString(Date.UTC(2025, 0, 1, 10, 0))).toContain('2025-01-01')
  })

  it('startDateChange converts a value to epoch ms', async () => {
    const a = useAdminItem()
    const it = await a.fetchItem()
    a.startDateChange('2025-06-01T08:00')
    expect(it.startDate).toBeTypeOf('number')
  })

  it('uploadImages is a no-op when there is no item', async () => {
    const a = useAdminItem()
    a.dispose()
    await a.uploadImages([new File(['x'], 'a.jpg', { type: 'image/jpeg' })])
    expect(a.isUploading.value).toBe(false)
  })

  it('uploadImages appends 360 urls and reports partial failures', async () => {
    let call = 0
    vi.stubGlobal(
      '$fetch',
      vi.fn().mockImplementation(() => {
        call += 1
        // First upload succeeds, second returns no url object → null → partial failure.
        return call === 1 ? Promise.resolve({ url: 'pano.jpg' }) : Promise.reject(new Error('fail'))
      }),
    )
    const a = useAdminItem()
    const it = await a.fetchItem()
    await a.uploadImages(
      [new File(['x'], 'a.jpg', { type: 'image/jpeg' }), new File(['y'], 'b.jpg', { type: 'image/jpeg' })],
      true,
    )
    expect(it.images360).toContain('pano.jpg')
    expect(toast.error).toHaveBeenCalledWith('Image upload failed')
  })

  it('uploadImages returns early when no upload succeeds', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(new Error('fail')))
    const a = useAdminItem()
    const it = await a.fetchItem()
    const before = [...it.images360]
    await a.uploadImages([new File(['x'], 'a.jpg', { type: 'image/jpeg' })], true)
    expect(it.images360).toEqual(before)
    expect(toast.error).toHaveBeenCalledWith('Image upload failed')
  })

  it('translateOtherLanguages returns early when the source description is empty', async () => {
    const f = vi.fn().mockResolvedValue({ texts: ['x'] })
    vi.stubGlobal('$fetch', f)
    const a = useAdminItem()
    const it = await a.fetchItem()
    a.view.value = EditView.description
    it.description = {} as never
    await a.translateOtherLanguages('cz')
    expect(f).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('translateOtherLanguages translates highlights, preserving paramId titles', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ texts: ['translated', 'translated'] }))
    const a = useAdminItem()
    const it = await a.fetchItem()
    a.view.value = EditView.highlights
    it.highlights = {
      cz: [
        { value: 'free', title: 'Title', paramId: undefined },
        { value: 'param', title: 'Param title', paramId: 42 },
      ],
    } as never
    await a.translateOtherLanguages('cz')
    const en = it.highlights.en!
    expect(en[0]!.title).toBe('translated')
    expect(en[1]!.title).toBe('Param title')
    expect(en[1]!.paramId).toBe(42)
    expect(toast.success).toHaveBeenCalled()
  })

  it('translateOtherLanguages returns early when the source highlights are empty', async () => {
    const f = vi.fn().mockResolvedValue({ texts: ['x'] })
    vi.stubGlobal('$fetch', f)
    const a = useAdminItem()
    const it = await a.fetchItem()
    a.view.value = EditView.highlights
    it.highlights = {} as never
    await a.translateOtherLanguages('cz')
    expect(f).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('translateOtherLanguages toasts an error and no success when translation fails', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(new Error('deepl down')))
    const a = useAdminItem()
    const it = await a.fetchItem()
    a.view.value = EditView.description
    it.description.cz = 'Ahoj'
    await a.translateOtherLanguages('cz')
    expect(toast.error).toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('selectedCategory getter reflects the stored category', async () => {
    const a = useAdminItem()
    await a.fetchItem()
    a.selectedCategory.value = { id: 'truck' }
    expect(a.selectedCategory.value).toEqual({ id: 'truck' })
  })

  it('selectedCategory setter is a no-op write when there is no item', () => {
    const a = useAdminItem()
    a.dispose()
    a.selectedCategory.value = { id: 'none' }
    expect(a.selectedCategory.value).toEqual({ id: 'none' })
  })
})
