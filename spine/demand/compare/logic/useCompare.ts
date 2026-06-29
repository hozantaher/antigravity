import { useToast } from 'vue-toastification'

const MAX_COMPARE_ITEMS = 4
const STORAGE_KEY = 'auction24:compare-ids'

const sanitize = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(0, MAX_COMPARE_ITEMS) : []

// SSR-safe singleton: starts empty so the server render and the first client paint match; the real
// localStorage read happens after mount (hydrate). A synchronous useLocalStorage read would make
// the card's compare-active state differ from the server HTML and trigger a hydration mismatch.
const ids = ref<string[]>([])

const persist = (value: string[]): void => {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    /* private mode — ignore */
  }
}

let hydrated = false
const hydrate = (): void => {
  if (hydrated || typeof window === 'undefined') return
  hydrated = true
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) ids.value = sanitize(JSON.parse(raw))
  } catch {
    /* corrupted entry — keep the empty default */
  }
}

// Mirror add/remove/clear made in other tabs into this tab's state.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', e => {
    if (e.key !== STORAGE_KEY) return
    if (e.newValue === null) {
      ids.value = []
      return
    }
    try {
      ids.value = sanitize(JSON.parse(e.newValue))
    } catch {
      /* bad payload from another tab — ignore */
    }
  })
}

export type CompareToggleResult = 'added' | 'removed' | 'full'

export const useCompare = () => {
  tryOnMounted(hydrate)

  const { t } = useI18n()
  const toast = useToast()
  const tracking = useTracking()

  const has = (id: string): boolean => ids.value.includes(id)

  const toggle = (id: string): CompareToggleResult => {
    if (has(id)) {
      ids.value = ids.value.filter(x => x !== id)
      persist(ids.value)
      return 'removed'
    }
    if (ids.value.length >= MAX_COMPARE_ITEMS) return 'full'
    ids.value = [...ids.value, id]
    persist(ids.value)
    tracking.compareAdd(id) // recommendation signal (no-op until consent)
    return 'added'
  }

  // One place mapping the toggle result → toast so every entry point stays in sync.
  const toggleWithToast = (id: string): CompareToggleResult => {
    const result = toggle(id)
    if (result === 'added') toast.success(t('compare.addedToast', { count: ids.value.length, max: MAX_COMPARE_ITEMS }))
    else if (result === 'removed') toast.info(t('compare.removedToast'))
    else toast.warning(t('compare.fullToast', { max: MAX_COMPARE_ITEMS }))
    return result
  }

  const remove = (id: string): void => {
    if (!has(id)) return
    ids.value = ids.value.filter(x => x !== id)
    persist(ids.value)
  }

  const clear = (): void => {
    ids.value = []
    persist(ids.value)
  }

  return { ids: readonly(ids), has, toggle, toggleWithToast, remove, clear, maxItems: MAX_COMPARE_ITEMS }
}

// Compare picks are anonymous shopping intent — clear them on sign-out so they don't leak across
// users on a shared device. Module-level (no component context) so signOut() can call it.
export const resetCompare = (): void => {
  ids.value = []
  if (typeof window === 'undefined') return
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* private mode — ignore */
  }
}
