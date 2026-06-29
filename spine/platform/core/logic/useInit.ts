import { whenAuthReady } from '~/features/platform/auth-account/logic/state'

const warnFetch = (what: string) => (e: unknown) => console.error(`[init] failed to load ${what}`, e)

export default function useInit() {
  const { init: userInit } = useUser()
  const { fetchLanguages } = useLanguages()
  const { fetchCountries } = useCountries()
  const { fetchCurrencies } = useCurrencies()
  const { fetchCategories, fetchCategoryParams } = useCategories()

  // Boot must degrade, not crash: a single failed fetch here would otherwise
  // throw out of the init plugin and take down the whole app at hydration.
  const fetchDataSync = async () => {
    const tasks: Promise<unknown>[] = [fetchCategories().catch(warnFetch('categories'))]
    // SSR is anonymous (no token) and whenAuthReady() never resolves on the
    // server, so only the client fetches the user — and only after Firebase has
    // restored the session, otherwise /api/me runs token-less, returns 204, and
    // wipes the user the auth listener is concurrently populating via exchange().
    if (import.meta.client) tasks.push(whenAuthReady().then(() => userInit()))
    await Promise.all(tasks)
  }

  // Item lists are fetched per-page (server-side pagination), not warmed here.
  const fetchDataAsync = () => {
    fetchLanguages().catch(warnFetch('languages'))
    fetchCountries().catch(warnFetch('countries'))
    fetchCurrencies().catch(warnFetch('currencies'))
    fetchCategoryParams().catch(warnFetch('categoryParams'))
  }

  return { fetchDataSync, fetchDataAsync }
}
