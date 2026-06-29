import { useToast } from 'vue-toastification'
import type { AdHighlight, Item } from '~/models'
import { ItemType } from '~/models'

export enum EditView {
  general,
  description,
  highlights,
  bids,
  questions,
}

// Shared template refs across the editor sub-components (no composable calls here).
const fieldCategory = ref()
const fieldType = ref()
const fieldStartDate = ref()
const fieldEndDate = ref()
const fieldMinBid = ref()
const fieldMinPrice = ref()
const fieldHidden = ref()
const fieldSold = ref()
const fieldTitle = ref()
const fieldPrice = ref()
const fieldTax = ref()
const fieldEmail = ref()
const fieldPhone = ref()

export default function useAdminItem() {
  const toast = useToast()
  const { translateDeepl } = useExternalTranslate()
  const { findCategory } = useCategories()
  const { execute: uploadSingle } = useImageUpload()

  const item = useState<Item | undefined>('admin:item', () => undefined)
  const itemPrev = useState<Item | undefined>('admin:itemPrev', () => undefined)
  const category = useState<any>('admin:category', () => undefined)
  const selectedLocale = useState('admin:selectedLocale', () => 'cz')
  const view = useState<EditView>('admin:view', () => EditView.general)
  const images = useState<string[]>('admin:images', () => [])
  const isUploading = useState('admin:isUploading', () => false)
  const showPresets = useState('admin:showPresets', () => false)
  const showOptions = useState('admin:showOptions', () => false)

  const getCreateItemID = () => `i${Date.now()}`

  const fetchItem = async (id?: string): Promise<Item> => {
    if (!id) {
      item.value = {
        id: getCreateItemID(),
        priceFrom: {},
        minBid: {},
        minimalPrice: {},
        description: {},
        images: [],
        images360: [],
        highlights: {},
        bids: [],
        taxIncluded: false,
        sold: false,
        hidden: false,
        closed: false,
        specs: {},
      } as unknown as Item
      itemPrev.value = undefined
      category.value = undefined
      images.value = []
      showPresets.value = true
      return item.value!
    }
    const data = await $fetch<Item>(`/api/item/${id}`)
    if (!data.specs) data.specs = {}
    // Legacy/migrated items can have null prices (mapper maps null amount → undefined), but the
    // editor binds v-model="item.priceFrom!.amount" etc. — ensure the objects exist or the form
    // crashes reading .amount of undefined. Mirrors the new-item path above.
    if (!data.priceFrom) data.priceFrom = {}
    if (!data.minBid) data.minBid = {}
    if (!data.minimalPrice) data.minimalPrice = {}
    item.value = data
    itemPrev.value = JSON.parse(JSON.stringify(data))
    category.value = findCategory(data.categoryId)
    showPresets.value = false
    images.value = []
    if (data.image) images.value.push(data.image)
    if (data.images.length) images.value = [...images.value, ...data.images]
    return item.value!
  }

  const removeEmptyHighlights = () => {
    if (!item.value) return
    for (const key of Object.keys(item.value.highlights))
      item.value.highlights[key] = (item.value.highlights[key] ?? []).filter(h => h.value)
  }

  const getLocalDateString = (ts?: number): string => (ts ? formatDate(ts, 'YYYY-MM-DDTHH:mm') : '')

  const saveItem = async () => {
    removeEmptyHighlights()

    if (!images.value.length) {
      toast.error('Images are empty')
      return
    }

    if (item.value!.startDate && item.value!.endDate && item.value!.startDate > item.value!.endDate) {
      toast.error('Invalid auction dates')
      return
    }

    if (item.value!.winner && (item.value!.endDate ?? 0) > Date.now()) {
      toast.error('The auction already has a winner, to reopen the auction first delete the bids and the winner')
      return
    }

    item.value!.image = images.value[0] ?? ''
    item.value!.images = images.value.slice(1)

    if (item.value!.type === ItemType.auction && (item.value!.endDate ?? 0) > Date.now()) item.value!.closed = false

    if (item.value!.type === ItemType.ad && itemPrev.value?.type === ItemType.auction) {
      item.value!.closed = false
      item.value!.minimalPrice = undefined
      item.value!.minBid = undefined
      item.value!.startDate = undefined
      item.value!.endDate = undefined
    }

    item.value!.updated = Date.now()

    if (itemPrev.value?.hidden !== item.value!.hidden) item.value!.visibleUpdated = Date.now()

    if (!itemPrev.value) {
      item.value!.created = Date.now()
      item.value!.visibleUpdated = Date.now()
    }

    try {
      if (itemPrev.value) await $fetch(`/api/admin/item/${item.value!.id}`, { method: 'PUT', body: item.value })
      else await $fetch('/api/admin/item', { method: 'POST', body: item.value })
      itemPrev.value = JSON.parse(JSON.stringify(item.value))
      toast.success('Item changes has been saved')
    } catch (e) {
      toast.error('Something went wrong')
      console.error(e)
    }
  }

  const startDateChange = (value: string) => {
    item.value!.startDate = value ? new Date(value).getTime() : undefined
  }

  const endDateChange = (value: string | null) => {
    item.value!.endDate = value ? new Date(value).getTime() : undefined
  }

  const uploadImages = async (files: File[], is360 = false) => {
    if (!item.value) return
    const itemId = item.value.id
    isUploading.value = true
    try {
      // Independent uploads (distinct UUID object paths) → run them in parallel; Promise.all
      // preserves input order, so the gallery keeps the order the admin picked.
      const urls = (await Promise.all(files.map(f => uploadSingle(f, itemId)))).filter((url): url is string => !!url)
      if (urls.length < files.length) toast.error('Image upload failed')
      if (!urls.length) return
      if (is360) item.value.images360 = [...item.value.images360, ...urls]
      else images.value = [...images.value, ...urls]
    } finally {
      isUploading.value = false
    }
  }

  const translateOtherLanguages = async (sourceCode: string) => {
    try {
      if (view.value === EditView.description) {
        const textToTranslate = item.value!.description[sourceCode]
        if (!textToTranslate) return
        for (const [key, code] of Object.entries(deeplLocales)) {
          if (key === sourceCode) continue
          const result = await translateDeepl(textToTranslate, code, getDeeplLocale(sourceCode))
          item.value!.description[key] = result[0]?.text ?? ''
        }
        toast.success('Translated to all languages')
        return
      }

      if (view.value === EditView.highlights) {
        const textToTranslate = item.value!.highlights[sourceCode]
        if (!textToTranslate) return
        for (const [key, code] of Object.entries(deeplLocales)) {
          if (key === sourceCode) continue
          const highlightsValues = await translateDeepl(
            textToTranslate.map((h: AdHighlight) => h.value),
            code,
            getDeeplLocale(sourceCode),
          )
          const highlightsTitles = await translateDeepl(
            textToTranslate.map((h: AdHighlight) => h.title),
            code,
            getDeeplLocale(sourceCode),
          )
          const out: AdHighlight[] = []
          for (let index = 0; index < highlightsValues.length; index++) {
            const src = textToTranslate[index]
            const title = src?.paramId ? src.title : (highlightsTitles[index]?.text ?? '')
            out.push({ value: highlightsValues[index]?.text ?? '', title, paramId: src?.paramId })
          }
          item.value!.highlights[key] = out
        }
        toast.success('Translated to all languages')
      }
    } catch {
      toast.error('Translation failed')
    }
  }

  const clearBids = () => {
    item.value!.bids = []
    item.value!.winner = undefined
  }

  const dispose = () => {
    item.value = undefined
    images.value = []
    view.value = EditView.general
  }

  const selectedCategory = computed({
    get: () => category.value,
    set: (cat: any) => {
      category.value = cat
      if (item.value && cat) item.value.categoryId = cat.id
    },
  })

  return {
    view,
    fieldCategory,
    fieldType,
    fieldStartDate,
    fieldEndDate,
    fieldMinBid,
    fieldMinPrice,
    fieldHidden,
    fieldSold,
    fieldTitle,
    fieldPrice,
    fieldTax,
    fieldEmail,
    fieldPhone,
    fetchItem,
    saveItem,
    startDateChange,
    endDateChange,
    getLocalDateString,
    uploadImages,
    translateOtherLanguages,
    clearBids,
    showPresets,
    showOptions,
    item: computed(() => item.value),
    selectedCategory,
    selectedLocale,
    images,
    isUploading,
    dispose,
  }
}
