// Replaces auction24's <InitApp> bootstrap: prefetch categories + user (sync)
// then items/languages/countries/currencies/category-params (async).
export default defineNuxtPlugin(async () => {
  const { fetchDataSync, fetchDataAsync } = useInit()
  await fetchDataSync()
  fetchDataAsync()
})
