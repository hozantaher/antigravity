/**
 * Polyfill localStorage for MSW's CookieStore which runs in jsdom
 * (detected as browser environment) and needs a working localStorage.
 * Must be listed before setup.js in setupFiles.
 *
 * Also patches global fetch so relative URLs (e.g. /api/foo) resolve to
 * http://localhost:5175 — Node's undici rejects relative URLs, but MSW
 * intercepts the absolute form correctly.
 */
try {
  globalThis.localStorage.getItem('__probe__')
} catch {
  const store = {}
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v) },
      removeItem: (k) => { delete store[k] },
      clear: () => { for (const k in store) delete store[k] },
      key: (i) => Object.keys(store)[i] ?? null,
      get length() { return Object.keys(store).length },
    },
  })
}
