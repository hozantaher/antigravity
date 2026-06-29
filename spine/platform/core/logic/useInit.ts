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
    // The user/auth fetch is deliberately NOT awaited: blocking the init plugin here gates
    // hydration/interactivity on /api/me (everyone) and the Firebase session restore (returning
    // users) before the app can mount. Route guards await whenAuthReady() independently and SSR
    // renders anonymous, so letting the user settle in the background patches the already-painted
    // UI without a hydration mismatch. SSR is anonymous (no token) and whenAuthReady() never
    // resolves on the server, so the client is the only side that fetches the user — and only
    // after Firebase restored the session, otherwise /api/me runs token-less, returns 204, and
    // wipes the user the auth listener is concurrently populating via exchange().
    if (import.meta.client) whenAuthReady().then(userInit).catch(warnFetch('user'))
    // Categories feed the nav/category menu; awaited so SSR + first paint have them (static
    // fixtures, so cheap). This is the only thing the init plugin blocks mount on now.
    await fetchCategories().catch(warnFetch('categories'))
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
